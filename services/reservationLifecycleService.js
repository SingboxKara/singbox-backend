import { isReservationStatusConfirmed } from "./reservationService.js";
import { isReservationFinished } from "./reviewService.js";

function safeStatus(status) {
  return String(status || "").trim().toLowerCase();
}

export function isReservationCompletedStatus(status) {
  return safeStatus(status) === "completed";
}

export function isReservationEligibleForReview(reservation) {
  if (!reservation) return false;

  const status = safeStatus(reservation.status);
  const allowedStatus =
    isReservationStatusConfirmed(status) || isReservationCompletedStatus(status);

  return allowedStatus && isReservationFinished(reservation);
}

export function isReservationEligibleForPostSession(reservation) {
  return isReservationEligibleForReview(reservation);
}

export function buildReservationLifecycleSnapshot(reservation) {
  if (!reservation) {
    return {
      exists: false,
      isFinished: false,
      isConfirmedLike: false,
      isCompleted: false,
      eligibleForReview: false,
      eligibleForPostSession: false,
    };
  }

  const status = safeStatus(reservation.status);
  const isConfirmedLike =
    isReservationStatusConfirmed(status) || isReservationCompletedStatus(status);

  const finished = isReservationFinished(reservation);

  return {
    exists: true,
    isFinished: finished,
    isConfirmedLike,
    isCompleted: isReservationCompletedStatus(status),
    eligibleForReview: isConfirmedLike && finished,
    eligibleForPostSession: isConfirmedLike && finished,
  };
}
