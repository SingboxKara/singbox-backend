import express from "express";

import { supabase } from "../config/supabase.js";
import { authMiddleware } from "../middlewares/auth.js";
import { updateUserProfileInUsersTable } from "../services/userService.js";
import {
  getUserGamificationSnapshot,
} from "../services/gamificationService.js";
import {
  getAvailableSingcoins,
  spendSingcoins,
} from "../services/singcoinService.js";
import { SINGCOINS_REWARD_COST } from "../constants/booking.js";

const router = express.Router();

router.get("/api/me", authMiddleware, async (req, res) => {
  try {
    if (!supabase) {
      return res.status(500).json({ error: "Supabase non configuré" });
    }

    const [{ data: user, error: userErr }, gamification] = await Promise.all([
      supabase
        .from("users")
        .select(
          "id,email,prenom,nom,telephone,pays,adresse,complement,cp,ville,naissance,stripe_customer_id,default_payment_method_id,card_brand,card_last4,card_exp_month,card_exp_year,created_at"
        )
        .eq("id", req.userId)
        .single(),
      getUserGamificationSnapshot(req.userId).catch(() => null),
    ]);

    if (userErr || !user) {
      return res.status(400).json({ error: "Utilisateur introuvable" });
    }

    const singcoinsBalance = Number(gamification?.singcoins?.balance || 0);

    return res.json({
      id: user.id,
      email: user.email,
      created_at: user.created_at || null,
      singcoins_balance: singcoinsBalance,

      // Alias compat temporaire si un front legacy lit encore "points"
      points: singcoinsBalance,

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

router.post("/api/add-points", authMiddleware, async (_req, res) => {
  return res.status(410).json({
    error: "Route obsolète. Utilisez désormais le système Singcoins.",
  });
});

router.post("/api/use-loyalty", authMiddleware, async (_req, res) => {
  return res.status(410).json({
    error: "Route obsolète. Utilisez désormais le système Singcoins.",
  });
});

router.post("/api/use-singcoins", authMiddleware, async (req, res) => {
  try {
    const amount = Number(req.body?.amount || SINGCOINS_REWARD_COST);

    if (!Number.isFinite(amount) || amount <= 0) {
      return res.status(400).json({ error: "Montant Singcoins invalide" });
    }

    const currentBalance = await getAvailableSingcoins(req.userId);
    if (currentBalance < amount) {
      return res.status(400).json({
        error: "Pas assez de Singcoins",
        currentSingcoins: currentBalance,
        requiredSingcoins: amount,
      });
    }

    const result = await spendSingcoins(req.userId, amount);

    if (!result.success) {
      return res.status(400).json({
        error: result.reason || "Impossible d'utiliser les Singcoins",
        currentSingcoins: result.current ?? currentBalance,
        requiredSingcoins: result.required ?? amount,
      });
    }

    return res.json({
      success: true,
      message: `${amount} Singcoins utilisés`,
      deducted: result.deducted,
      remaining: result.remaining,
    });
  } catch (e) {
    console.error("Erreur /api/use-singcoins :", e);
    return res.status(500).json({ error: "Erreur serveur" });
  }
});

router.get("/api/account/gamification", authMiddleware, async (req, res) => {
  try {
    const data = await getUserGamificationSnapshot(req.userId);
    return res.json(data);
  } catch (err) {
    console.error("gamification error", err);
    return res.status(500).json({ error: "Erreur serveur interne" });
  }
});

export default router;