// backend/routes/userRoutes.js

import express from "express";

import { supabase } from "../config/supabase.js";
import { authMiddleware } from "../middlewares/auth.js";
import { updateUserProfileInUsersTable } from "../services/userService.js";
import { LOYALTY_POINTS_COST } from "../constants/booking.js";

const router = express.Router();

router.get("/api/me", authMiddleware, async (req, res) => {
  try {
    if (!supabase) {
      return res.status(500).json({ error: "Supabase non configuré" });
    }

    const { data: user, error: userErr } = await supabase
      .from("users")
      .select(
        "id,email,prenom,nom,telephone,pays,adresse,complement,cp,ville,naissance,points,stripe_customer_id,default_payment_method_id,card_brand,card_last4,card_exp_month,card_exp_year"
      )
      .eq("id", req.userId)
      .single();

    if (userErr || !user) {
      return res.status(400).json({ error: "Utilisateur introuvable" });
    }

    return res.json({
      id: user.id,
      email: user.email,
      points: user.points ?? 0,
      payment: {
        stripe_customer_id: user.stripe_customer_id ?? null,
        default_payment_method_id: user.default_payment_method_id ?? null,
        card: user.card_last4
          ? {
              brand: user.card_brand,
              last4: user.card_last4,
              exp_month: user.card_exp_month,
              exp_year: user.card_exp_year,
            }
          : null,
      },
      profile: {
        prenom: user.prenom,
        nom: user.nom,
        telephone: user.telephone,
        pays: user.pays,
        adresse: user.adresse,
        complement: user.complement,
        cp: user.cp,
        ville: user.ville,
        naissance: user.naissance,
      },
    });
  } catch (err) {
    console.error("Erreur me :", err);
    return res.status(500).json({ error: "Erreur serveur" });
  }
});

router.post("/api/me", authMiddleware, async (req, res) => {
  try {
    if (!supabase) {
      return res.status(500).json({ error: "Supabase non configuré" });
    }

    await updateUserProfileInUsersTable(req.userId, req.body || {});
    return res.json({ ok: true });
  } catch (e) {
    console.error("Erreur POST /api/me :", e);
    return res.status(500).json({ error: "Erreur serveur" });
  }
});

/**
 * IMPORTANT :
 * On supprime la possibilité d'ajouter des points librement depuis le front.
 * Les points doivent être crédités uniquement par la logique serveur métier
 * (réservation payée, fidélité, admin contrôlé, etc.)
 */
router.post("/api/add-points", authMiddleware, async (_req, res) => {
  return res.status(403).json({
    error: "Action non autorisée",
  });
});

router.post("/api/use-loyalty", authMiddleware, async (req, res) => {
  try {
    if (!supabase) {
      return res.status(500).json({ error: "Supabase non configuré" });
    }

    const { data: user, error } = await supabase
      .from("users")
      .select("points")
      .eq("id", req.userId)
      .single();

    if (error || !user) {
      return res.status(400).json({ error: "Utilisateur introuvable" });
    }

    if (Number(user.points || 0) < LOYALTY_POINTS_COST) {
      return res.status(400).json({ error: "Pas assez de points" });
    }

    const { error: updateErr } = await supabase
      .from("users")
      .update({
        points: Number(user.points) - LOYALTY_POINTS_COST,
        updated_at: new Date().toISOString(),
      })
      .eq("id", req.userId);

    if (updateErr) {
      console.error(updateErr);
      return res.status(500).json({ error: "Impossible de retirer les points" });
    }

    return res.json({
      success: true,
      message: `${LOYALTY_POINTS_COST} points utilisés`,
    });
  } catch (e) {
    console.error("Erreur /api/use-loyalty :", e);
    return res.status(500).json({ error: "Erreur serveur" });
  }
});

import { getUserGamificationSnapshot } from '../services/gamificationService.js';

router.get('/account/gamification', authMiddleware, async (req, res) => {
  try {
    const userId = req.user.id;

    const data = await getUserGamificationSnapshot(userId);

    res.json(data);
  } catch (err) {
    console.error('gamification error', err);
    res.status(500).json({ error: 'gamification_error' });
  }
});

export default router;