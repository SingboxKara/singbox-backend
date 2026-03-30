import express from "express";
import { supabase } from "../config/supabase.js";
import { authMiddleware } from "../middlewares/auth.js";
import { listUserPasses } from "../services/passService.js";
import { getFullAccountSnapshot } from "../services/accountReadService.js";

const router = express.Router();

function ensureSupabase() {
  if (!supabase) {
    throw new Error("Supabase non configuré");
  }
}

function safeText(value, maxLen = 255) {
  return String(value ?? "").trim().slice(0, maxLen);
}

function normalizeReferralPayload(referral, referrals) {
  const validatedCount = Array.isArray(referrals)
    ? referrals.filter((r) => String(r?.status || "").toLowerCase() === "validated").length
    : 0;

  return {
    code: referral?.referral_code || null,
    referred_by_code: referral?.referred_by_code || null,
    progressCurrent: validatedCount,
    progressTarget: 4,
    rewardAvailable: validatedCount >= 4,
  };
}

router.get("/api/account-dashboard", authMiddleware, async (req, res) => {
  try {
    ensureSupabase();

    const userId = safeText(req.userId, 120);

    if (!userId) {
      return res.status(401).json({ error: "Utilisateur non authentifié" });
    }

    const snapshot = await getFullAccountSnapshot(userId);

    if (!snapshot?.profile) {
      return res.status(404).json({ error: "Utilisateur introuvable" });
    }

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
        persons,
        email,
        name,
        payment_intent_id,
        deposit_payment_intent_id,
        guest_manage_token,
        checked_in_at,
        completed_at,
        cancelled_at,
        refunded_at,
        is_weekend,
        is_daytime,
        is_group_session,
        session_minutes
      `)
      .eq("user_id", userId)
      .order("start_time", { ascending: false });

    if (reservationsError) throw reservationsError;

    const passes = await listUserPasses(userId);

    const { data: referrals, error: referralsError } = await supabase
      .from("referrals")
      .select("status")
      .eq("referrer_user_id", userId);

    if (referralsError) throw referralsError;

    return res.json({
      success: true,
      account: {
        profile: snapshot.profile,
        payment: snapshot.payment,
        loyalty: snapshot.loyalty,
        referral: normalizeReferralPayload(snapshot.referral, referrals),
      },
      reservations: Array.isArray(reservations) ? reservations : [],
      passes: Array.isArray(passes) ? passes : [],
    });
  } catch (error) {
    console.error("Erreur /api/account-dashboard :", error);
    return res.status(500).json({ error: "Erreur serveur" });
  }
});

export default router;
