import crypto from "crypto";

import { supabase } from "../config/supabase.js";
import {
  CONFIRMED_STATUSES,
  CANCELLED_OR_REFUNDED_STATUSES,
  MODIFICATION_DEADLINE_HOURS,
  REFUND_DEADLINE_HOURS,
  GUEST_MANAGE_TOKEN_BYTES,
  GUEST_MANAGE_TOKEN_TTL_DAYS,
  SINGCOINS_REWARD_COST,
} from "../constants/booking.js";
import {
  addDaysToDateString,
  areTimeRangesOverlapping,
  hoursBeforeDate,
  formatDateToYYYYMMDD,
} from "../utils/dates.js";

function assertSupabaseConfigured() {
  if (!supabase) {
    throw new Error("Supabase non configuré");
  }
}

function isValidReservationId(reservationId) {
  return typeof reservationId === "string" || typeof reservationId === "number";
}

function normalizeEmail(email) {
  return String(email || "").trim().toLowerCase();
}

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function safeTrim(value) {
  return String(value || "").trim();
}

function toFiniteNumber(value, fallback = 0) {
  const num = Number(value);
  return Number.isFinite(num) ? num : fallback;
}

function isLikelyGuestToken(token) {
  const safeToken = String(token || "").trim();
  if (!safeToken) return false;

  const expectedHexLength = Number(GUEST_MANAGE_TOKEN_BYTES || 0) * 2;
  if (expectedHexLength > 0 && safeToken.length !== expectedHexLength) return false;

  return /^[a-f0-9]+$/i.test(safeToken);
}

function normalizeCandidateDates(localDate) {
  if (!isNonEmptyString(localDate)) return [];

  return [...new Set([
    localDate,
    addDaysToDateString(localDate, -1),
    addDaysToDateString(localDate, 1),
  ])].filter(Boolean);
}

function buildReservationPaymentIntentOrFilter(paymentIntentId) {
  const safePaymentIntentId = safeTrim(paymentIntentId);
  if (!safePaymentIntentId) return null;

  return [
    `payment_intent_id.eq.${safePaymentIntentId}`,
    `latest_payment_intent_id.eq.${safePaymentIntentId}`,
    `original_payment_intent_id.eq.${safePaymentIntentId}`,
    `deposit_payment_intent_id.eq.${safePaymentIntentId}`,
  ].join(",");
}

function computeDerivedReservationFields({
  startTime,
  endTime,
  persons,
  montant,
  singcoinsUsed,
  singcoinsSpent,
  latestPaymentIntentId,
  originalPaymentIntentId,
  lastAutoChargeAmount,
  refundedAmount,
}) {
  const start = startTime ? new Date(startTime) : null;
  const end = endTime ? new Date(endTime) : null;
  const safePersons = Math.max(toFiniteNumber(persons, 2), 1);

  const payload = {
    persons: safePersons,
    billable_persons: Math.max(safePersons, 2),
    montant: toFiniteNumber(montant, 0),
    free_session: toFiniteNumber(montant, 0) <= 0,
    singcoins_used: !!singcoinsUsed,
    singcoins_spent: !!singcoinsUsed
      ? Math.max(toFiniteNumber(singcoinsSpent, SINGCOINS_REWARD_COST), 0)
      : 0,
    latest_payment_intent_id: latestPaymentIntentId || null,
    original_payment_intent_id: originalPaymentIntentId || null,
    last_auto_charge_amount: Math.max(toFiniteNumber(lastAutoChargeAmount, 0), 0),
    refunded_amount: Math.max(toFiniteNumber(refundedAmount, 0), 0),
  };

  if (start && Number.isFinite(start.getTime())) {
    payload.date = formatDateToYYYYMMDD(start);
    payload.datetime = start.toISOString();
    payload.start_time = start.toISOString();
    payload.is_weekend = start.getDay() === 0 || start.getDay() === 6;
    payload.is_daytime = start.getHours() >= 12 && start.getHours() < 18;
  }

  if (end && Number.isFinite(end.getTime())) {
    payload.end_time = end.toISOString();
  }

  if (
    start &&
    end &&
    Number.isFinite(start.getTime()) &&
    Number.isFinite(end.getTime())
  ) {
    payload.session_minutes = Math.max(
      0,
      Math.round((end.getTime() - start.getTime()) / 60000)
    );
  }

  payload.is_group_session = safePersons >= 3;

  return payload;
}

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

export function isReservationStatusCompleted(statusRaw) {
  return normalizeReservationStatus(statusRaw) === "completed";
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
  assertSupabaseConfigured();

  const safeBoxId = Number(boxId);
  if (!Number.isFinite(safeBoxId) || safeBoxId <= 0) {
    throw new Error("boxId invalide");
  }

  const candidateDates = normalizeCandidateDates(localDate);

  let query = supabase
    .from("reservations")
    .select("id, box_id, start_time, end_time, status, date")
    .eq("box_id", safeBoxId);

  if (candidateDates.length > 0) {
    query = query.in("date", candidateDates);
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
  if (!isNonEmptyString(startTime) || !isNonEmptyString(endTime)) {
    throw new Error("startTime/endTime invalides");
  }

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
  assertSupabaseConfigured();

  if (!isValidReservationId(reservationId)) {
    throw new Error("reservationId invalide");
  }

  const { data, error } = await supabase
    .from("reservations")
    .select("*")
    .eq("id", reservationId)
    .maybeSingle();

  if (error) throw error;
  return data || null;
}

export async function getReservationByGuestToken(token) {
  assertSupabaseConfigured();

  const safeToken = String(token || "").trim();
  if (!isLikelyGuestToken(safeToken)) return null;

  const { data, error } = await supabase
    .from("reservations")
    .select("*")
    .eq("guest_manage_token", safeToken)
    .maybeSingle();

  if (error) throw error;
  if (!data) return null;

  const expiresAt = data.guest_manage_token_expires_at
    ? new Date(data.guest_manage_token_expires_at)
    : null;

  if (
    expiresAt &&
    Number.isFinite(expiresAt.getTime()) &&
    expiresAt.getTime() < Date.now()
  ) {
    return null;
  }

  return data;
}

export async function isPaymentIntentAlreadyUsed(paymentIntentId) {
  assertSupabaseConfigured();

  const filter = buildReservationPaymentIntentOrFilter(paymentIntentId);
  if (!filter) return false;

  const { data, error } = await supabase
    .from("reservations")
    .select("id")
    .or(filter)
    .limit(1);

  if (error) throw error;
  return Array.isArray(data) && data.length > 0;
}

export async function getReservationByPaymentIntentId(paymentIntentId) {
  assertSupabaseConfigured();

  const filter = buildReservationPaymentIntentOrFilter(paymentIntentId);
  if (!filter) return null;

  const { data, error } = await supabase
    .from("reservations")
    .select("*")
    .or(filter)
    .limit(1)
    .maybeSingle();

  if (error) throw error;
  return data || null;
}

export async function updateReservationById(reservationId, payload) {
  assertSupabaseConfigured();

  if (!isValidReservationId(reservationId)) {
    throw new Error("reservationId invalide");
  }

  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("payload de réservation invalide");
  }

  const safePayload = { ...payload };

  if ("email" in safePayload) {
    safePayload.email = normalizeEmail(safePayload.email);
  }

  if ("status" in safePayload) {
    safePayload.status = safeTrim(safePayload.status);
  }

  if (
    "guest_manage_token" in safePayload &&
    safePayload.guest_manage_token != null &&
    !isLikelyGuestToken(safePayload.guest_manage_token)
  ) {
    throw new Error("guest_manage_token invalide");
  }

  safePayload.updated_at = new Date().toISOString();

  const { data, error } = await supabase
    .from("reservations")
    .update(safePayload)
    .eq("id", reservationId)
    .select()
    .single();

  if (error) throw error;
  return data;
}

export async function applyReservationModification(modReq) {
  assertSupabaseConfigured();

  if (!modReq?.reservation_id) {
    throw new Error("Modification request invalide");
  }

  const reservation = await getReservationById(modReq.reservation_id);
  if (!reservation) {
    throw new Error("Réservation introuvable pour la modification");
  }

  if (isReservationStatusCompleted(reservation.status)) {
    throw new Error("Réservation déjà complétée, modification impossible");
  }

  if (isReservationStatusCancelledOrRefunded(reservation.status)) {
    throw new Error("Réservation annulée/remboursée, modification impossible");
  }

  if (!isReservationStatusModifiable(reservation.status)) {
    throw new Error("Réservation non modifiable");
  }

  const newStart = modReq.new_start_time;
  const newEnd = modReq.new_end_time;
  const newPersons = Math.max(
    toFiniteNumber(modReq.new_persons, reservation.persons || 2),
    1
  );
  const targetBoxId = Number(modReq.box_id || reservation.box_id || 1);

  if (!isNonEmptyString(newStart) || !isNonEmptyString(newEnd)) {
    throw new Error("Nouveau créneau invalide");
  }

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

  const singcoinsUsed = Boolean(reservation.singcoins_used);
  const newAmount = toFiniteNumber(modReq.new_amount, reservation.montant || 0);
  const deltaAmount = toFiniteNumber(modReq.delta_amount, 0);
  const paymentIntentId =
    modReq.stripe_payment_intent_id ||
    reservation.latest_payment_intent_id ||
    reservation.payment_intent_id ||
    reservation.original_payment_intent_id ||
    null;

  const derived = computeDerivedReservationFields({
    startTime: newStart,
    endTime: newEnd,
    persons: newPersons,
    montant: newAmount,
    singcoinsUsed,
    singcoinsSpent: reservation.singcoins_spent || SINGCOINS_REWARD_COST,
    latestPaymentIntentId: paymentIntentId,
    originalPaymentIntentId:
      reservation.original_payment_intent_id ||
      reservation.payment_intent_id ||
      paymentIntentId,
    lastAutoChargeAmount: deltaAmount > 0 ? deltaAmount : 0,
    refundedAmount: reservation.refunded_amount || 0,
  });

  const payload = {
    ...derived,
    box_id: targetBoxId,
    updated_at: new Date().toISOString(),
  };

  const { error } = await supabase
    .from("reservations")
    .update(payload)
    .eq("id", modReq.reservation_id);

  if (error) throw error;

  return getReservationById(modReq.reservation_id);
}

export async function getReservationsByIds(reservationIds = []) {
  assertSupabaseConfigured();

  const ids = Array.isArray(reservationIds)
    ? reservationIds.filter(Boolean)
    : [];

  if (ids.length === 0) return [];

  const { data, error } = await supabase
    .from("reservations")
    .select("*")
    .in("id", ids);

  if (error) throw error;
  return data || [];
}

export async function markReservationCompleted(reservationId) {
  const reservation = await getReservationById(reservationId);
  if (!reservation) {
    throw new Error("Réservation introuvable");
  }

  if (isReservationStatusCompleted(reservation.status)) {
    return reservation;
  }

  if (isReservationStatusCancelledOrRefunded(reservation.status)) {
    throw new Error("Impossible de compléter une réservation annulée ou remboursée");
  }

  return await updateReservationById(reservationId, {
    status: "completed",
    completed_at: new Date().toISOString(),
  });
}