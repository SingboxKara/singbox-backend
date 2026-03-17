// backend/routes/reviewRoutes.js

import express from "express";

import { supabase } from "../config/supabase.js";
import { safeText } from "../utils/validators.js";
import {
  getReviewRequestByToken,
  expireReviewRequestIfNeeded,
  getReservationById,
  createReviewFromToken,
  markReviewRequestUsed,
} from "../services/reviewService.js";

const router = express.Router();

router.get("/api/review/verify-token", async (req, res) => {
  try {
    if (!supabase) {
      return res.status(500).json({ valid: false, error: "Supabase non configuré" });
    }

    const token = String(req.query.token || "").trim();
    if (!token) {
      return res.status(400).json({ valid: false, error: "token manquant" });
    }

    let request = await getReviewRequestByToken(token);

    if (!request) {
      return res.status(404).json({ valid: false, error: "Lien d’avis introuvable" });
    }

    request = await expireReviewRequestIfNeeded(request);

    if (request.status === "used") {
      return res.status(400).json({
        valid: false,
        error: "Ce lien d’avis a déjà été utilisé",
      });
    }

    if (request.status === "expired") {
      return res.status(400).json({
        valid: false,
        error: "Ce lien d’avis a expiré",
      });
    }

    const reservation = await getReservationById(request.reservation_id);

    return res.json({
      valid: true,
      request: {
        reservation_id: request.reservation_id,
        email: request.email,
        name: request.name,
        expires_at: request.expires_at,
        status: request.status,
      },
      reservation: reservation
        ? {
            id: reservation.id,
            email: reservation.email,
            name: reservation.name,
            start_time: reservation.start_time,
            end_time: reservation.end_time,
            box_id: reservation.box_id,
            status: reservation.status,
          }
        : null,
    });
  } catch (e) {
    console.error("Erreur /api/review/verify-token :", e);
    return res.status(500).json({ valid: false, error: "Erreur serveur" });
  }
});

router.get("/api/review-request/validate", async (req, res) => {
  try {
    if (!supabase) {
      return res.status(500).json({ error: "Supabase non configuré" });
    }

    const token = String(req.query.token || "").trim();
    if (!token) {
      return res.status(400).json({ valid: false, error: "token manquant" });
    }

    let request = await getReviewRequestByToken(token);

    if (!request) {
      return res.status(404).json({ valid: false, error: "Lien d’avis introuvable" });
    }

    request = await expireReviewRequestIfNeeded(request);

    if (request.status === "used") {
      return res.status(400).json({
        valid: false,
        error: "Ce lien d’avis a déjà été utilisé",
      });
    }

    if (request.status === "expired") {
      return res.status(400).json({
        valid: false,
        error: "Ce lien d’avis a expiré",
      });
    }

    const reservation = await getReservationById(request.reservation_id);

    return res.json({
      valid: true,
      request: {
        reservation_id: request.reservation_id,
        email: request.email,
        name: request.name,
        expires_at: request.expires_at,
        status: request.status,
      },
      reservation: reservation
        ? {
            id: reservation.id,
            email: reservation.email,
            name: reservation.name,
            start_time: reservation.start_time,
            end_time: reservation.end_time,
            box_id: reservation.box_id,
            status: reservation.status,
          }
        : null,
    });
  } catch (e) {
    console.error("Erreur /api/review-request/validate :", e);
    return res.status(500).json({ valid: false, error: "Erreur serveur" });
  }
});

router.post("/api/review/submit", async (req, res) => {
  try {
    if (!supabase) {
      return res.status(500).json({ error: "Supabase non configuré" });
    }

    const token = String(req.body?.token || "").trim();
    const firstName = safeText(req.body?.firstName, 80);
    const email = safeText(req.body?.email, 160);
    const comment = safeText(req.body?.comment, 4000);
    const rating = Number(req.body?.rating);
    const consentPublication = req.body?.consentPublication === true;
    const honeypot = String(req.body?.website || "").trim();

    if (honeypot) {
      return res.status(400).json({ error: "Spam détecté" });
    }

    if (!token) {
      return res.status(400).json({ error: "token manquant" });
    }

    if (!Number.isFinite(rating) || rating < 1 || rating > 5) {
      return res.status(400).json({ error: "Note invalide" });
    }

    if (!comment || comment.length < 3) {
      return res.status(400).json({ error: "Commentaire trop court" });
    }

    if (!consentPublication) {
      return res.status(400).json({ error: "Consentement requis" });
    }

    const result = await createReviewFromToken({
      token,
      firstName,
      email,
      rating,
      comment,
      consentPublication,
    });

    return res.json({
      success: true,
      alreadyExists: !!result.alreadyExists,
      review: result.review,
      message: result.alreadyExists
        ? "Un avis existait déjà pour cette réservation."
        : "Merci, votre avis a bien été enregistré et sera modéré avant publication.",
    });
  } catch (e) {
    console.error("Erreur /api/review/submit :", e);

    return res.status(400).json({
      error: e?.message || "Erreur serveur",
      debug:
        process.env.NODE_ENV !== "production"
          ? {
              name: e?.name || null,
              code: e?.code || null,
              details: e?.details || null,
              hint: e?.hint || null,
            }
          : undefined,
    });
  }
});

router.post("/api/review-request/mark-used", async (req, res) => {
  try {
    if (!supabase) {
      return res.status(500).json({ error: "Supabase non configuré" });
    }

    const token = String(req.body?.token || "").trim();
    if (!token) {
      return res.status(400).json({ error: "token manquant" });
    }

    let request = await getReviewRequestByToken(token);

    if (!request) {
      return res.status(404).json({ error: "Lien d’avis introuvable" });
    }

    request = await expireReviewRequestIfNeeded(request);

    if (request.status === "expired") {
      return res.status(400).json({ error: "Lien expiré" });
    }

    if (request.status === "used") {
      return res.json({ success: true, alreadyUsed: true });
    }

    const updated = await markReviewRequestUsed(token);

    return res.json({
      success: true,
      request: updated,
    });
  } catch (e) {
    console.error("Erreur /api/review-request/mark-used :", e);
    return res.status(500).json({ error: "Erreur serveur" });
  }
});

export default router;