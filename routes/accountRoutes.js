import express from "express";
import { supabase } from "../config/supabase.js";
import { authMiddleware } from "../middlewares/auth.js";
import { listUserPasses } from "../services/passService.js";

const router = express.Router();

function ensureSupabase() {
  if (!supabase) {
    throw new Error("Supabase non configuré");
  }
}

function safeText(value, maxLen = 255) {
  return String(value ?? "").trim().slice(0, maxLen);
}

function toSafeInt(value, fallback = 0) {
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) ? n : fallback;
}

function normalizeUserRow(user) {
  if (!user || typeof user !== "object") {
    return null;
  }

  return {
    id: user.id ?? null,
    email: safeText(user.email, 255) || null,
    singcoins_balance: Math.max(0, toSafeInt(user.singcoins_balance, 0)),
    prenom: safeText(user.prenom, 80),
    nom: safeText(user.nom, 80),
    telephone: safeText(user.telephone, 40),
    created_at: user.created_at ?? null,
    referral_code: safeText(user.referral_code, 80) || null,
    referred_by_code: safeText(user.referred_by_code, 80) || null,
    default_payment_method_id: user.default_payment_method_id ?? null,
    card_brand: user.card_brand ?? null,
    card_last4: user.card_last4 ?? null,
    card_exp_month: user.card_exp_month ?? null,
    card_exp_year: user.card_exp_year ?? null,
  };
}

function normalizeReferralPayload(user, referrals) {
  const validatedCount = Array.isArray(referrals)
    ? referrals.filter((r) => String(r?.status || "").toLowerCase() === "validated").length
    : 0;

  return {
    code: user?.referral_code || null,
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

    const { data: userRow, error: userError } = await supabase
      .from("users")
      .select(`
        id,
        email,
        singcoins_balance,
        prenom,
        nom,
        telephone,
        created_at,
        referral_code,
        referred_by_code,
        default_payment_method_id,
        card_brand,
        card_last4,
        card_exp_month,
        card_exp_year
      `)
      .eq("id", userId)
      .maybeSingle();

    if (userError) throw userError;
    if (!userRow) {
      return res.status(404).json({ error: "Utilisateur introuvable" });
    }

    const user = normalizeUserRow(userRow);

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
      user,
      reservations: Array.isArray(reservations) ? reservations : [],
      passes: Array.isArray(passes) ? passes : [],
      referral: normalizeReferralPayload(user, referrals),
    });
  } catch (error) {
    console.error("Erreur /api/account-dashboard :", error);
    return res.status(500).json({ error: "Erreur serveur" });
  }
});

export default router;
