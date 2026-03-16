// backend/routes/adminRoutes.js

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

import { buildSlotIsoRange } from "../services/pricingService.js";
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

import { getBillablePersons } from "../services/pricingService.js";
import { sendReservationEmail } from "../services/emailService.js";

const router = express.Router();

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
    } = req.body || {};

    const safeName = safeText(name, 120);
    const safeEmail = safeText(email, 160);
    const safeDate = safeText(date, 10);
    const safeBoxId = getNumericBoxId(box_id);
    const safeStartMinutes = Number(start_minutes);
    const safePersons = clampPersons(persons || 2);
    const safeStatus = safeText(status, 40) || "confirmed";

    if (!safeName || !safeEmail || !safeDate) {
      return res.status(400).json({
        error: "name, email et date sont requis",
      });
    }

    if (!/^\d{4}-\d{2}-\d{2}$/.test(safeDate)) {
      return res.status(400).json({ error: "date invalide (YYYY-MM-DD attendu)" });
    }

    if (!Number.isFinite(safeStartMinutes) || safeStartMinutes < 0 || safeStartMinutes >= 24 * 60) {
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

    const reservationRow = {
      name: safeName,
      email: safeEmail,
      datetime: startIso,
      created_at: new Date().toISOString(),
      start_time: startIso,
      box_id: safeBoxId,
      status: safeStatus,
      date: safeDate,
      end_time: endIso,
      payment_intent_id: null,
      deposit_payment_intent_id: null,
      deposit_amount_cents: 0,
      deposit_status: null,
      persons: safePersons,
      billable_persons: getBillablePersons(safePersons),
      montant: 0,
      free_session: true,
      loyalty_used: false,
      points_spent: 0,
      promo_code: null,
      refunded_amount: 0,
      last_auto_charge_amount: 0,
      updated_at: new Date().toISOString(),
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

    if (!isReservationStatusConfirmed(reservation.status)) {
      return res.status(400).json({
        error: "La réservation doit être confirmée pour envoyer une demande d’avis",
      });
    }

    if (!isReservationFinished(reservation)) {
      return res.status(400).json({
        error: "La séance n’est pas encore terminée",
      });
    }

    const result = await sendReviewRequestEmail(reservation);

    return res.json({
      success: result.sent,
      result,
    });
  } catch (e) {
    console.error("Erreur /api/admin/send-review-request :", e);
    return res.status(500).json({ error: "Erreur serveur lors de l’envoi de la demande d’avis" });
  }
});

router.all("/api/admin/send-completed-review-requests", requireAdminOrCron, async (req, res) => {
  try {
    if (!supabase) {
      return res.status(500).json({ error: "Supabase non configuré" });
    }

    const incomingLimit =
      req.method === "GET"
        ? req.query?.limit
        : req.body?.limit;

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
      (row) => isReservationStatusConfirmed(row.status) && isReservationFinished(row)
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
        console.error("Erreur envoi review request reservation", reservation.id, itemErr);
        results.push({
          reservationId: reservation.id,
          email: reservation.email,
          sent: false,
          reason: itemErr.message || "error",
        });
      }
    }

    return res.json({
      success: true,
      mode: req.isCron ? "cron" : "admin",
      totalProcessed: results.length,
      results,
    });
  } catch (e) {
    console.error("Erreur /api/admin/send-completed-review-requests :", e);
    return res.status(500).json({ error: "Erreur serveur lors de l’envoi en lot des demandes d’avis" });
  }
});

export default router;