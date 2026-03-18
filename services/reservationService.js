// backend/services/reservationService.js

import crypto from "crypto";

import { supabase } from "../config/supabase.js";
import {
  CONFIRMED_STATUSES,
  CANCELLED_OR_REFUNDED_STATUSES,
  MODIFICATION_DEADLINE_HOURS,
  REFUND_DEADLINE_HOURS,
  GUEST_MANAGE_TOKEN_BYTES,
  GUEST_MANAGE_TOKEN_TTL_DAYS,
  LOYALTY_POINTS_COST,
} from "../constants/booking.js";
import {
  addDaysToDateString,
  areTimeRangesOverlapping,
  hoursBeforeDate,
  formatDateToYYYYMMDD,
} from "../utils/dates.js";

export function normalizeReservationStatus(statusRaw) {
  return String(statusRaw || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim()
    .toLowerCase();
}

export function isReservationStatusConfirmed(statusRaw) {
  const s = normalizeReservationStatus(statusRaw);
  return CONFIRMED_STATUSES.map(normalizeReservationStatus).includes(s);
}

export function isReservationStatusCancelledOrRefunded(statusRaw) {
  const s = normalizeReservationStatus(statusRaw);
  return CANCELLED_OR_REFUNDED_STATUSES
    .map(normalizeReservationStatus)
    .includes(s);
}

export function isReservationStatusModifiable(statusRaw) {
  return isReservationStatusConfirmed(statusRaw);
}

export function isWithinModificationWindow(startTimeIso) {
  const diff = hoursBeforeDate(startTimeIso);
  if (diff === null) return false;
  return diff >= MODIFICATION_DEADLINE_HOURS;
}

export function isWithinRefundWindow(startTimeIso) {
  const diff = hoursBeforeDate(startTimeIso);
  if (diff === null) return false;
  return diff >= REFUND_DEADLINE_HOURS;
}

export function generateGuestManageToken() {
  return crypto.randomBytes(GUEST_MANAGE_TOKEN_BYTES).toString("hex");
}

export function computeGuestManageTokenExpiresAt(fromDate = new Date()) {
  const expires = new Date(fromDate);
  expires.setDate(expires.getDate() + GUEST_MANAGE_TOKEN_TTL_DAYS);
  return expires.toISOString();
}

export async function getPotentiallyConflictingReservations({
  boxId,
  localDate,
  excludeReservationId = null,
}) {
  if (!supabase) throw new Error("Supabase non configuré");

  const candidateDates = [];
  if (localDate) {
    candidateDates.push(localDate);
    candidateDates.push(addDaysToDateString(localDate, -1));
    candidateDates.push(addDaysToDateString(localDate, 1));
  }

  let query = supabase
    .from("reservations")
    .select("id, box_id, start_time, end_time, status, date")
    .eq("box_id", boxId);

  if (candidateDates.length > 0) {
    query = query.in("date", [...new Set(candidateDates)]);
  }

  if (excludeReservationId) {
    query = query.neq("id", excludeReservationId);
  }

  const { data, error } = await query;

  if (error) throw error;

  return (data || []).filter((row) => isReservationStatusConfirmed(row.status));
}

export async function hasReservationConflict({
  boxId,
  startTime,
  endTime,
  localDate = null,
  excludeReservationId = null,
}) {
  const reservations = await getPotentiallyConflictingReservations({
    boxId,
    localDate,
    excludeReservationId,
  });

  return reservations.some((row) =>
    areTimeRangesOverlapping(row.start_time, row.end_time, startTime, endTime)
  );
}

export async function getReservationById(reservationId) {
  if (!supabase) throw new Error("Supabase non configuré");

  const { data, error } = await supabase
    .from("reservations")
    .select("*")
    .eq("id", reservationId)
    .single();

  if (error) throw error;
  return data;
}

export async function getReservationByGuestToken(token) {
  if (!supabase) throw new Error("Supabase non configuré");

  const safeToken = String(token || "").trim();
  if (!safeToken) return null;

  const { data, error } = await supabase
    .from("reservations")
    .select("*")
    .eq("guest_manage_token", safeToken)
    .single();

  if (error) {
    if (error.code === "PGRST116") return null;
    throw error;
  }

  if (!data) return null;

  const expiresAt = data.guest_manage_token_expires_at
    ? new Date(data.guest_manage_token_expires_at)
    : null;

  if (expiresAt && expiresAt.getTime() < Date.now()) {
    return null;
  }

  return data;
}

export async function updateReservationById(reservationId, payload) {
  const { data, error } = await supabase
    .from("reservations")
    .update(payload)
    .eq("id", reservationId)
    .select()
    .single();

  if (error) throw error;
  return data;
}

export async function applyReservationModification(modReq) {
  if (!modReq?.reservation_id) {
    throw new Error("Modification request invalide");
  }

  const reservation = await getReservationById(modReq.reservation_id);
  if (!reservation) {
    throw new Error("Réservation introuvable pour la modification");
  }

  const newStart = modReq.new_start_time;
  const newEnd = modReq.new_end_time;
  const newPersons = Number(modReq.new_persons || reservation.persons || 2);
  const targetBoxId = Number(modReq.box_id || reservation.box_id || 1);
  const targetLocalDate = formatDateToYYYYMMDD(new Date(newStart));

  const conflict = await hasReservationConflict({
    boxId: targetBoxId,
    startTime: newStart,
    endTime: newEnd,
    localDate: targetLocalDate,
    excludeReservationId: reservation.id,
  });

  if (conflict) {
    throw new Error("Le nouveau créneau n’est plus disponible");
  }

  const loyaltyUsed = Boolean(reservation.loyalty_used);
  const newAmount = Number(modReq.new_amount ?? reservation.montant ?? 0);
  const deltaAmount = Number(modReq.delta_amount ?? 0);
  const paymentIntentId =
    modReq.stripe_payment_intent_id ||
    reservation.latest_payment_intent_id ||
    reservation.payment_intent_id ||
    reservation.original_payment_intent_id ||
    null;

  const payload = {
    start_time: newStart,
    end_time: newEnd,
    date: targetLocalDate,
    datetime: newStart,
    box_id: targetBoxId,
    persons: newPersons,
    billable_persons: Math.max(newPersons, 2),
    montant: newAmount,
    free_session: newAmount <= 0,
    loyalty_used: loyaltyUsed,
    points_spent: loyaltyUsed ? Number(reservation.points_spent || LOYALTY_POINTS_COST) : 0,
    latest_payment_intent_id: paymentIntentId,
    original_payment_intent_id:
      reservation.original_payment_intent_id ||
      reservation.payment_intent_id ||
      paymentIntentId,
    last_auto_charge_amount: deltaAmount > 0 ? deltaAmount : 0,
    updated_at: new Date().toISOString(),
  };

  const { error } = await supabase
    .from("reservations")
    .update(payload)
    .eq("id", modReq.reservation_id);

  if (error) throw error;

  return getReservationById(modReq.reservation_id);
}