import express from "express";

import { supabase } from "../config/supabase.js";
import {
  requireSupabaseAdmin,
  requireAdminOrCron,
} from "../middlewares/admin.js";

import {
  getNumericBoxId,
  safeText,
  clampPersons,
} from "../utils/validators.js";

import {
  buildSlotIsoRange,
  getBillablePersons,
} from "../services/pricingService.js";

import {
  hasReservationConflict,
  isReservationStatusConfirmed,
} from "../services/reservationService.js";

import {
  getReservationById,
  isReservationFinished,
  sendReviewRequestEmail,
  getExistingReviewRequestByReservationId,
} from "../services/reviewService.js";

import { sendReservationEmail } from "../services/emailService.js";
import {
  processReservationGamification,
  getUserGamificationSnapshot,
} from "../services/gamificationService.js";

import {
  processReservationPostSession,
  processFinishedReservationsPostSessionBatch,
} from "../services/postSessionService.js";

const router = express.Router();

async function writeAdminAuditLog(req, payload) {
  try {
    if (!supabase) return;

    const actorUserId = req?.user?.id || null;
    const actorEmail = req?.user?.email || null;
    const actorType = req?.isCron ? "cron" : "admin";

    const row = {
      actor_user_id: actorUserId,
      actor_email: actorEmail,
      actor_type: actorType,
      action: payload?.action || "unknown_action",
      target_table: payload?.target_table || null,
      target_id: payload?.target_id != null ? String(payload.target_id) : null,
      metadata: payload?.metadata || {},
    };

    const { error } = await supabase.from("admin_audit_logs").insert(row);

    if (error) {
      console.error("Erreur admin_audit_logs insert :", error);
    }
  } catch (e) {
    console.error("Erreur writeAdminAuditLog :", e);
  }
}

function normalizeEmail(email) {
  return String(email || "").trim().toLowerCase();
}

async function findUserIdByEmail(email) {
  try {
    if (!supabase) return null;

    const safeEmail = normalizeEmail(email);
    if (!safeEmail) return null;

    const { data, error } = await supabase
      .from("users")
      .select("id, email")
      .eq("email", safeEmail)
      .maybeSingle();

    if (error) {
      console.error("Erreur findUserIdByEmail :", error);
      return null;
    }

    return data?.id || null;
  } catch (e) {
    console.error("Erreur findUserIdByEmail catch :", e);
    return null;
  }
}

async function resolveReservationUserId({ explicitUserId = null, email = null }) {
  const safeExplicitUserId = safeText(explicitUserId, 120) || null;
  if (safeExplicitUserId) return safeExplicitUserId;

  const byEmail = await findUserIdByEmail(email);
  return byEmail || null;
}

async function ensureReservationHasUserId(reservation) {
  try {
    if (!supabase || !reservation?.id) return reservation;
    if (reservation.user_id) return reservation;

    const resolvedUserId = await resolveReservationUserId({
      explicitUserId: null,
      email: reservation.email || null,
    });

    if (!resolvedUserId) return reservation;

    const { data, error } = await supabase
      .from("reservations")
      .update({
        user_id: resolvedUserId,
        updated_at: new Date().toISOString(),
      })
      .eq("id", reservation.id)
      .select()
      .single();

    if (error) {
      console.error("Erreur ensureReservationHasUserId update :", error);
      return reservation;
    }

    return data || reservation;
  } catch (e) {
    console.error("Erreur ensureReservationHasUserId catch :", e);
    return reservation;
  }
}

router.post("/api/admin/create-free-reservation", requireSupabaseAdmin, async (req, res) => {
  try {
    if (!supabase) {
      return res.status(500).json({ error: "Supabase non configuré" });
    }

    const {
      name,
      email,
      date,
      box_id,
      start_minutes,
      persons,
      status,
      user_id,
    } = req.body || {};

    const safeName = safeText(name, 120);
    const safeEmail = normalizeEmail(email);
    const safeDate = safeText(date, 10);
    const safeBoxId = getNumericBoxId(box_id);
    const safeStartMinutes = Number(start_minutes);
    const safePersons = clampPersons(persons || 2);
    const safeStatus = safeText(status, 40) || "confirmed";

    const resolvedUserId = await resolveReservationUserId({
      explicitUserId: user_id,
      email: safeEmail,
    });

    if (!safeName || !safeEmail || !safeDate) {
      return res.status(400).json({
        error: "name, email et date sont requis",
      });
    }

    if (!/^\d{4}-\d{2}-\d{2}$/.test(safeDate)) {
      return res.status(400).json({
        error: "date invalide (YYYY-MM-DD attendu)",
      });
    }

    if (
      !Number.isFinite(safeStartMinutes) ||
      safeStartMinutes < 0 ||
      safeStartMinutes >= 24 * 60
    ) {
      return res.status(400).json({ error: "start_minutes invalide" });
    }

    const hourFloat =
      Math.floor(safeStartMinutes / 60) + (safeStartMinutes % 60) / 60;

    const { startIso, endIso } = buildSlotIsoRange(safeDate, hourFloat);

    const hasConflict = await hasReservationConflict({
      boxId: safeBoxId,
      startTime: startIso,
      endTime: endIso,
      localDate: safeDate,
    });

    if (hasConflict) {
      return res.status(409).json({
        error: "Ce créneau est déjà réservé pour cette box",
      });
    }

    const startDate = new Date(startIso);
    const endDate = new Date(endIso);
    const nowIso = new Date().toISOString();

    const reservationRow = {
      name: safeName,
      email: safeEmail,
      user_id: resolvedUserId,
      datetime: startIso,
      created_at: nowIso,
      start_time: startIso,
      box_id: safeBoxId,
      status: safeStatus,
      date: safeDate,
      end_time: endIso,
      payment_intent_id: null,
      original_payment_intent_id: null,
      latest_payment_intent_id: null,
      deposit_payment_intent_id: null,
      deposit_amount_cents: 0,
      deposit_status: null,
      persons: safePersons,
      billable_persons: getBillablePersons(safePersons),
      montant: 0,
      free_session: true,
      singcoins_used: false,
      singcoins_spent: 0,
      promo_code: null,
      refunded_amount: 0,
      last_auto_charge_amount: 0,
      checked_in_at: null,
      completed_at: null,
      cancelled_at: null,
      refunded_at: null,
      is_weekend: startDate.getDay() === 0 || startDate.getDay() === 6,
      is_daytime: startDate.getHours() >= 12 && startDate.getHours() < 18,
      is_group_session: safePersons >= 3,
      session_minutes: Math.floor((endDate - startDate) / 60000),
      updated_at: nowIso,
    };

    const { data: insertedReservation, error: insertError } = await supabase
      .from("reservations")
      .insert(reservationRow)
      .select()
      .single();

    if (insertError || !insertedReservation) {
      console.error("Erreur insert admin free reservation :", insertError);
      return res.status(500).json({
        error: "Impossible de créer la réservation gratuite",
      });
    }

    try {
      await sendReservationEmail(insertedReservation);
    } catch (mailErr) {
      console.error("Erreur envoi mail admin free reservation :", mailErr);
    }

    await writeAdminAuditLog(req, {
      action: "create_free_reservation",
      target_table: "reservations",
      target_id: insertedReservation.id,
      metadata: {
        email: insertedReservation.email || null,
        user_id: insertedReservation.user_id || null,
        date: insertedReservation.date || null,
        start_time: insertedReservation.start_time || null,
        box_id: insertedReservation.box_id || null,
        persons: insertedReservation.persons || null,
        status: insertedReservation.status || null,
      },
    });

    return res.json({
      success: true,
      reservation: insertedReservation,
    });
  } catch (e) {
    console.error("Erreur /api/admin/create-free-reservation :", e);
    return res.status(500).json({
      error: "Erreur serveur lors de la création de la réservation gratuite",
    });
  }
});

router.post("/api/admin/mark-reservation-completed", requireSupabaseAdmin, async (req, res) => {
  try {
    if (!supabase) {
      return res.status(500).json({ error: "Supabase non configuré" });
    }

    const { reservationId, completedAt, checkedInAt } = req.body || {};

    if (!reservationId) {
      return res.status(400).json({ error: "reservationId manquant" });
    }

    const originalReservation = await getReservationById(reservationId);
    if (!originalReservation) {
      return res.status(404).json({ error: "Réservation introuvable" });
    }

    let reservation = await ensureReservationHasUserId(originalReservation);

    const nowIso = new Date().toISOString();
    const safeCheckedInAt =
      checkedInAt || reservation.checked_in_at || reservation.start_time || nowIso;
    const safeCompletedAt =
      completedAt || reservation.completed_at || reservation.end_time || nowIso;

    const startDate = new Date(reservation.start_time);
    const endDate = new Date(reservation.end_time);

    const updatePayload = {
      status: "completed",
      user_id: reservation.user_id || null,
      checked_in_at: safeCheckedInAt,
      completed_at: safeCompletedAt,
      is_weekend:
        reservation.is_weekend ??
        (startDate.getDay() === 0 || startDate.getDay() === 6),
      is_daytime:
        reservation.is_daytime ??
        (startDate.getHours() >= 12 && startDate.getHours() < 18),
      is_group_session:
        reservation.is_group_session ??
        Number(reservation.persons || 0) >= 3,
      session_minutes:
        reservation.session_minutes ??
        Math.floor((endDate - startDate) / 60000),
      updated_at: nowIso,
    };

    const { data: updatedReservation, error: updateError } = await supabase
      .from("reservations")
      .update(updatePayload)
      .eq("id", reservationId)
      .select()
      .single();

    if (updateError || !updatedReservation) {
      console.error("Erreur mark reservation completed :", updateError);
      return res.status(500).json({
        error: "Impossible de marquer la réservation comme complétée",
      });
    }

    let finalReservation = updatedReservation;
    if (!finalReservation.user_id) {
      finalReservation = await ensureReservationHasUserId(updatedReservation);
    }

    let gamification = null;
    let gamificationErrorMessage = null;

    try {
      gamification = await processReservationGamification(finalReservation.id);
    } catch (gErr) {
      console.error("Erreur processReservationGamification :", gErr);
      gamificationErrorMessage = gErr?.message || "Erreur gamification";
    }

    if (!gamification && finalReservation.user_id) {
      try {
        gamification = await getUserGamificationSnapshot(finalReservation.user_id);
      } catch (snapshotErr) {
        console.error("Erreur snapshot après completed :", snapshotErr);
      }
    }

    await writeAdminAuditLog(req, {
      action: "mark_reservation_completed",
      target_table: "reservations",
      target_id: finalReservation.id,
      metadata: {
        email: finalReservation.email || null,
        user_id: finalReservation.user_id || null,
        previous_status: originalReservation.status || null,
        new_status: finalReservation.status || null,
        checked_in_at: finalReservation.checked_in_at || null,
        completed_at: finalReservation.completed_at || null,
        gamification_snapshot_returned: !!gamification,
        gamification_error: gamificationErrorMessage,
      },
    });

    return res.json({
      success: true,
      reservation: finalReservation,
      gamification,
      warning: !finalReservation.user_id
        ? "Réservation complétée sans user_id : gamification potentiellement limitée."
        : null,
    });
  } catch (e) {
    console.error("Erreur /api/admin/mark-reservation-completed :", e);
    return res.status(500).json({
      error: "Erreur serveur lors de la validation de la réservation",
    });
  }
});

router.post("/api/admin/send-review-request", requireSupabaseAdmin, async (req, res) => {
  try {
    if (!supabase) {
      return res.status(500).json({ error: "Supabase non configuré" });
    }

    const { reservationId } = req.body || {};
    if (!reservationId) {
      return res.status(400).json({ error: "reservationId manquant" });
    }

    const reservation = await getReservationById(reservationId);
    if (!reservation) {
      return res.status(404).json({ error: "Réservation introuvable" });
    }

    if (
      !isReservationStatusConfirmed(reservation.status) &&
      reservation.status !== "completed"
    ) {
      return res.status(400).json({
        error:
          "La réservation doit être confirmée ou complétée pour envoyer une demande d’avis",
      });
    }

    if (!isReservationFinished(reservation)) {
      return res.status(400).json({
        error: "La séance n’est pas encore terminée",
      });
    }

    const result = await sendReviewRequestEmail(reservation);

    await writeAdminAuditLog(req, {
      action: "send_review_request",
      target_table: "reservations",
      target_id: reservation.id,
      metadata: {
        email: reservation.email || null,
        sent: !!result?.sent,
        reason: result?.reason || null,
      },
    });

    return res.json({
      success: result.sent,
      result,
    });
  } catch (e) {
    console.error("Erreur /api/admin/send-review-request :", e);
    return res.status(500).json({
      error: "Erreur serveur lors de l’envoi de la demande d’avis",
    });
  }
});

router.all("/api/admin/send-completed-review-requests", requireAdminOrCron, async (req, res) => {
  try {
    if (!supabase) {
      return res.status(500).json({ error: "Supabase non configuré" });
    }

    const incomingLimit =
      req.method === "GET" ? req.query?.limit : req.body?.limit;

    const limit = Math.min(Math.max(Number(incomingLimit || 20), 1), 100);
    const nowIso = new Date().toISOString();

    const { data: reservations, error } = await supabase
      .from("reservations")
      .select("*")
      .lt("end_time", nowIso)
      .order("end_time", { ascending: false })
      .limit(limit);

    if (error) {
      throw error;
    }

    const confirmedFinishedReservations = (reservations || []).filter(
      (row) =>
        (isReservationStatusConfirmed(row.status) || row.status === "completed") &&
        isReservationFinished(row)
    );

    const results = [];

    for (const reservation of confirmedFinishedReservations) {
      try {
        const existing = await getExistingReviewRequestByReservationId(reservation.id);

        if (existing?.status === "used") {
          results.push({
            reservationId: reservation.id,
            email: reservation.email,
            skipped: true,
            reason: "already_used",
          });
          continue;
        }

        if (existing?.sent_at && existing?.status === "pending") {
          results.push({
            reservationId: reservation.id,
            email: reservation.email,
            skipped: true,
            reason: "already_sent",
          });
          continue;
        }

        const sendResult = await sendReviewRequestEmail(reservation);

        results.push({
          reservationId: reservation.id,
          email: reservation.email,
          sent: !!sendResult.sent,
          reason: sendResult.reason || null,
        });
      } catch (itemErr) {
        console.error(
          "Erreur envoi review request reservation",
          reservation.id,
          itemErr
        );
        results.push({
          reservationId: reservation.id,
          email: reservation.email,
          sent: false,
          reason: itemErr.message || "error",
        });
      }
    }

    await writeAdminAuditLog(req, {
      action: "send_completed_review_requests_batch",
      target_table: "reservations",
      target_id: null,
      metadata: {
        limit,
        totalProcessed: results.length,
        mode: req.isCron ? "cron" : "admin",
        results,
      },
    });

    return res.json({
      success: true,
      mode: req.isCron ? "cron" : "admin",
      totalProcessed: results.length,
      results,
    });
  } catch (e) {
    console.error("Erreur /api/admin/send-completed-review-requests :", e);
    return res.status(500).json({
      error: "Erreur serveur lors de l’envoi en lot des demandes d’avis",
    });
  }
});

router.post("/api/admin/process-post-session", requireSupabaseAdmin, async (req, res) => {
  try {
    const { reservationId } = req.body || {};

    if (!reservationId) {
      return res.status(400).json({ error: "reservationId manquant" });
    }

    const result = await processReservationPostSession(reservationId);

    await writeAdminAuditLog(req, {
      action: "process_post_session",
      target_table: "reservations",
      target_id: reservationId,
      metadata: {
        success: !!result?.success,
        skipped: !!result?.skipped,
        reason: result?.reason || null,
        message: result?.message || null,
      },
    });

    return res.json({
      success: true,
      result,
    });
  } catch (e) {
    console.error("Erreur /api/admin/process-post-session :", e);
    return res.status(500).json({
      error: "Erreur serveur lors du traitement post-session",
    });
  }
});

router.post("/api/admin/process-post-session-batch", requireAdminOrCron, async (req, res) => {
  try {
    const incomingLimit =
      req.method === "GET" ? req.query?.limit : req.body?.limit;

    const limit = Math.min(Math.max(Number(incomingLimit || 20), 1), 100);

    const result = await processFinishedReservationsPostSessionBatch(limit);

    await writeAdminAuditLog(req, {
      action: "process_post_session_batch",
      target_table: "reservations",
      target_id: null,
      metadata: {
        mode: req.isCron ? "cron" : "admin",
        limit,
        totalProcessed: result?.totalProcessed || 0,
      },
    });

    return res.json(result);
  } catch (e) {
    console.error("Erreur /api/admin/process-post-session-batch :", e);
    return res.status(500).json({
      error: "Erreur serveur lors du batch post-session",
    });
  }
});

export default router;
