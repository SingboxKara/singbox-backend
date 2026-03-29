import express from "express";
import { supabase } from "../config/supabase.js";
import { authMiddleware } from "../middlewares/auth.js";
import { listUserPasses } from "../services/passService.js";

const router = express.Router();

router.get("/api/account-dashboard", authMiddleware, async (req, res) => {
  try {
    const userId = req.userId;

    // USER
    const { data: user, error: userError } = await supabase
      .from("users")
      .select("id, email, singcoins, pseudo, created_at")
      .eq("id", userId)
      .single();

    if (userError) throw userError;

    // RESERVATIONS (optimisé)
    const { data: reservations, error: reservationsError } = await supabase
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
      .order("start_time", { ascending: false });

    if (reservationsError) throw reservationsError;

    // PASSES
    const passes = await listUserPasses(userId);

    // REFERRAL (simple version safe)
    const { data: referrals } = await supabase
      .from("referrals")
      .select("status")
      .eq("referrer_user_id", userId);

    const validatedCount = (referrals || []).filter(r => r.status === "validated").length;

    const referral = {
      code: user?.pseudo || userId,
      progressCurrent: validatedCount,
      progressTarget: 4,
      rewardAvailable: validatedCount >= 4
    };

    return res.json({
      success: true,
      user,
      reservations: reservations || [],
      passes: passes || [],
      referral
    });

  } catch (error) {
    console.error("Erreur /api/account-dashboard :", error);
    return res.status(500).json({ error: "Erreur serveur" });
  }
});

export default router;
