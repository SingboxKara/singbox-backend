// backend/services/reservationService.js

import { supabase } from "../config/supabase.js";
import {
  CONFIRMED_STATUSES,
  CANCELLED_OR_REFUNDED_STATUSES,
  MODIFICATION_DEADLINE_HOURS,
} from "../constants/booking.js";
import {
  addDaysToDateString,
  areTimeRangesOverlapping,
  hoursBeforeDate,
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