import { supabase } from "../config/supabase.js";
import {
  getReservationById,
  sendReviewRequestEmail,
} from "./reviewService.js";
import { processReservationGamification } from "./gamificationService.js";
import {
  isReservationEligibleForPostSession,
} from "./reservationLifecycleService.js";

function nowIso() {
  return new Date().toISOString();
}

function safeText(value, maxLen = 500) {
  return String(value ?? "").trim().slice(0, maxLen);
}

function canProcessReservationPostSession(reservation) {
  if (!reservation) {
    return {
      ok: false,
      reason: "reservation_not_found",
      message: "Réservation introuvable",
    };
  }

  if (!isReservationEligibleForPostSession(reservation)) {
    return {
      ok: false,
      reason: "not_eligible",
      message: "Réservation non éligible au post-session",
    };
  }

  return {
    ok: true,
    reason: null,
    message: null,
  };
}

async function upsertPostSessionRun(reservationId, patch = {}) {
  if (!supabase) throw new Error("Supabase non configuré");

  const payload = {
    reservation_id: reservationId,
    updated_at: nowIso(),
    ...patch,
  };

  const { data, error } = await supabase
    .from("post_session_runs")
    .upsert(payload, { onConflict: "reservation_id" })
    .select()
    .single();

  if (error) throw error;
  return data;
}

export async function getPostSessionRun(reservationId) {
  if (!supabase) throw new Error("Supabase non configuré");

  const { data, error } = await supabase
    .from("post_session_runs")
    .select("*")
    .eq("reservation_id", reservationId)
    .maybeSingle();

  if (error) throw error;
  return data || null;
}

export async function processReservationPostSession(reservationId) {
  if (!supabase) throw new Error("Supabase non configuré");

  const reservation = await getReservationById(reservationId);

  const eligibility = canProcessReservationPostSession(reservation);

  await upsertPostSessionRun(reservationId, {
    reservation_status: reservation?.status || null,
    reservation_end_time: reservation?.end_time || null,
    started_at: nowIso(),
    last_attempt_at: nowIso(),
    last_error: eligibility.ok ? null : eligibility.message,
  });

  if (!eligibility.ok) {
    return {
      success: false,
      reservation: reservation || null,
      skipped: true,
      reason: eligibility.reason,
      message: eligibility.message,
      gamification: null,
      reviewRequest: null,
    };
  }

  let gamificationResult = null;
  let gamificationDone = false;
  let gamificationNote = null;

  try {
    gamificationResult = await processReservationGamification(reservation.id);
    gamificationDone = true;
    gamificationNote = gamificationResult
      ? "Gamification traitée"
      : "Gamification non applicable ou déjà traitée";
  } catch (error) {
    gamificationDone = false;
    gamificationNote = `Erreur gamification: ${safeText(error?.message || error, 500)}`;
  }

  let reviewResult = null;
  let reviewRequestDone = false;
  let reviewRequestNote = null;
  let promoCode = null;

  try {
    reviewResult = await sendReviewRequestEmail(reservation);

    reviewRequestDone = !!(
      reviewResult?.sent ||
      reviewResult?.reason === "already_sent" ||
      reviewResult?.reason === "already_used"
    );

    reviewRequestNote =
      reviewResult?.reason === "already_sent"
        ? "Demande d’avis déjà envoyée"
        : reviewResult?.reason === "already_used"
          ? "Demande d’avis déjà utilisée"
          : reviewResult?.sent
            ? "Demande d’avis envoyée"
            : safeText(reviewResult?.reason || "Demande d’avis non envoyée", 500);

    promoCode = reviewResult?.promoCode || null;
  } catch (error) {
    reviewRequestDone = false;
    reviewRequestNote = `Erreur demande d’avis: ${safeText(error?.message || error, 500)}`;
  }

  const success = gamificationDone && reviewRequestDone;
  const lastError = success
    ? null
    : [gamificationNote, reviewRequestNote]
        .filter(Boolean)
        .filter((text) => String(text).toLowerCase().startsWith("erreur"))
        .join(" | ") || null;

  await upsertPostSessionRun(reservationId, {
    reservation_status: reservation?.status || null,
    reservation_end_time: reservation?.end_time || null,
    last_attempt_at: nowIso(),
    last_success_at: success ? nowIso() : null,
    gamification_done: gamificationDone,
    gamification_note: gamificationNote,
    review_request_done: reviewRequestDone,
    review_request_note: reviewRequestNote,
    promo_code: promoCode,
    last_error: lastError,
  });

  return {
    success,
    reservation,
    skipped: false,
    reason: null,
    message: success
      ? "Post-session traité"
      : "Post-session traité partiellement",
    gamification: gamificationResult,
    reviewRequest: reviewResult,
  };
}

export async function processFinishedReservationsPostSessionBatch(limit = 20) {
  if (!supabase) throw new Error("Supabase non configuré");

  const safeLimit = Math.min(Math.max(Number(limit || 20), 1), 100);
  const now = nowIso();

  const { data: reservations, error } = await supabase
    .from("reservations")
    .select("*")
    .lt("end_time", now)
    .order("end_time", { ascending: false })
    .limit(safeLimit);

  if (error) throw error;

  const results = [];

  for (const reservation of reservations || []) {
    try {
      const result = await processReservationPostSession(reservation.id);

      results.push({
        reservationId: reservation.id,
        email: reservation.email || null,
        success: !!result.success,
        skipped: !!result.skipped,
        reason: result.reason || null,
        message: result.message || null,
      });
    } catch (error) {
      results.push({
        reservationId: reservation.id,
        email: reservation.email || null,
        success: false,
        skipped: false,
        reason: "error",
        message: safeText(error?.message || error, 500),
      });

      await upsertPostSessionRun(reservation.id, {
        reservation_status: reservation?.status || null,
        reservation_end_time: reservation?.end_time || null,
        last_attempt_at: nowIso(),
        last_error: safeText(error?.message || error, 500),
      });
    }
  }

  return {
    success: true,
    totalProcessed: results.length,
    results,
  };
}
