import express from "express";
import { supabase } from "../config/supabase.js";
import { authMiddleware } from "../middlewares/auth.js";
import { listUserPasses } from "../services/passService.js";

const router = express.Router();

router.get("/api/account-dashboard", authMiddleware, async (req, res) => {
  try {
    const userId = req.userId;

    // 🔥 TOUT EN PARALLÈLE
    const [
      userRes,
      reservationsRes,
      referralsRes,
      passesRes
    ] = await Promise.all([

      // USER
      supabase
        .from("users")
        .select("id, email, singcoins, pseudo, created_at")
        .eq("id", userId)
        .single(),

      // RESERVATIONS
      supabase
        .from("reservations")
        .select(`
          id,
          date,
          start_time,
          end_time,
          box_id,
          status,
          montant,
          paid_with_pass,
          user_pass_id,
          pass_places_used,
          persons
        `)
        .eq("user_id", userId)
        .order("start_time", { ascending: false }),

      // REFERRALS
      supabase
        .from("referrals")
        .select("status")
        .eq("referrer_user_id", userId),

      // PASSES
      listUserPasses(userId)
    ]);

    // 🔒 Gestion erreurs propre
    if (userRes.error) throw userRes.error;
    if (reservationsRes.error) throw reservationsRes.error;
    if (referralsRes.error) throw referralsRes.error;

    const user = userRes.data;
    const reservations = reservationsRes.data || [];
    const referrals = referralsRes.data || [];
    const passes = passesRes || [];

    // REFERRAL LOGIC
    const validatedCount = referrals.filter(r => r.status === "validated").length;

    const referral = {
      code: user?.pseudo || userId,
      progressCurrent: validatedCount,
      progressTarget: 4,
      rewardAvailable: validatedCount >= 4
    };

    return res.json({
      success: true,
      user,
      reservations,
      passes,
      referral
    });

  } catch (error) {
    console.error("❌ /api/account-dashboard :", error);
    return res.status(500).json({
      error: "Erreur serveur"
    });
  }
});

export default router;
