import crypto from "crypto";
import { supabase } from "../config/supabase.js";
import {
  REFERRAL_REQUIRED_VALID_COUNT,
  REFERRAL_FREE_SESSION_INCLUDED_PERSONS,
  REFERRAL_STATUSES,
  REFERRAL_REWARD_TYPES,
  REFERRAL_REWARD_STATUSES,
  REFERRAL_CODE_LENGTH,
  REFERRAL_SESSION_REWARD_LABEL,
} from "../constants/referral.js";

function assertSupabaseConfigured() {
  if (!supabase) {
    throw new Error("Supabase non configuré");
  }
}

function normalizeEmail(email) {
  return String(email || "").trim().toLowerCase();
}

function normalizeReferralCode(code) {
  return String(code || "").trim().toUpperCase();
}

function isValidUuid(value) {
  return typeof value === "string" && value.length >= 30;
}

function buildRandomReferralCode(length = REFERRAL_CODE_LENGTH) {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let out = "";
  const bytes = crypto.randomBytes(length * 2);

  for (let i = 0; i < bytes.length && out.length < length; i += 1) {
    out += alphabet[bytes[i] % alphabet.length];
  }

  return out.slice(0, length);
}

export async function generateUniqueReferralCode() {
  assertSupabaseConfigured();

  for (let i = 0; i < 20; i += 1) {
    const candidate = buildRandomReferralCode();

    const { data, error } = await supabase
      .from("users")
      .select("id")
      .eq("referral_code", candidate)
      .maybeSingle();

    if (error) throw error;
    if (!data) return candidate;
  }

  throw new Error("Impossible de générer un code de parrainage unique");
}

export async function ensureUserReferralCode(userId) {
  assertSupabaseConfigured();

  if (!isValidUuid(userId)) {
    throw new Error("userId invalide");
  }

  const { data: existing, error: readError } = await supabase
    .from("users")
    .select("id, referral_code")
    .eq("id", userId)
    .single();

  if (readError) throw readError;
  if (!existing) {
    throw new Error("Utilisateur introuvable");
  }

  if (existing.referral_code) {
    return normalizeReferralCode(existing.referral_code);
  }

  const newCode = await generateUniqueReferralCode();

  const { error: updateError } = await supabase
    .from("users")
    .update({
      referral_code: newCode,
      updated_at: new Date().toISOString(),
    })
    .eq("id", userId);

  if (updateError) throw updateError;

  return newCode;
}

export async function getUserReferralSummary(userId) {
  assertSupabaseConfigured();

  const referralCode = await ensureUserReferralCode(userId);

  const { count: validatedCount, error: countError } = await supabase
    .from("referrals")
    .select("id", { count: "exact", head: true })
    .eq("referrer_user_id", userId)
    .eq("status", REFERRAL_STATUSES.VALIDATED);

  if (countError) throw countError;

  const { data: reward, error: rewardError } = await supabase
    .from("referral_rewards")
    .select("*")
    .eq("user_id", userId)
    .eq("milestone", REFERRAL_REQUIRED_VALID_COUNT)
    .maybeSingle();

  if (rewardError) throw rewardError;

  const safeValidatedCount = Number(validatedCount || 0);
  const progressCurrent = Math.min(
    safeValidatedCount,
    REFERRAL_REQUIRED_VALID_COUNT
  );

  return {
    referralCode,
    referralLink: `https://singbox.fr/reservation?ref=${referralCode}`,
    validatedCount: safeValidatedCount,
    progressCurrent,
    progressTarget: REFERRAL_REQUIRED_VALID_COUNT,
    freeSessionReward: reward || null,
    hasRewardAvailable:
      reward?.status === REFERRAL_REWARD_STATUSES.AVAILABLE,
  };
}

export async function getUserByReferralCode(referralCode) {
  assertSupabaseConfigured();

  const safeCode = normalizeReferralCode(referralCode);
  if (!safeCode) return null;

  const { data, error } = await supabase
    .from("users")
    .select("id, email, telephone, referral_code")
    .eq("referral_code", safeCode)
    .maybeSingle();

  if (error) throw error;
  return data || null;
}

export async function getExistingReferralByReferredUserId(referredUserId) {
  assertSupabaseConfigured();

  if (!isValidUuid(referredUserId)) return null;

  const { data, error } = await supabase
    .from("referrals")
    .select("*")
    .eq("referred_user_id", referredUserId)
    .maybeSingle();

  if (error) throw error;
  return data || null;
}

export async function createPendingReferralForReservation({
  referrerUserId,
  referredUserId,
  referredEmail,
  referredPhone = null,
  referralCode,
  reservationId,
}) {
  assertSupabaseConfigured();

  const safeCode = normalizeReferralCode(referralCode);
  if (!safeCode || !isValidUuid(referrerUserId) || !isValidUuid(referredUserId)) {
    return { created: false, reason: "invalid_input" };
  }

  if (referrerUserId === referredUserId) {
    return { created: false, reason: "self_referral" };
  }

  const existingForReferred = await getExistingReferralByReferredUserId(referredUserId);
  if (existingForReferred) {
    return { created: false, reason: "already_referred" };
  }

  const { data: referrer, error: referrerError } = await supabase
    .from("users")
    .select("id, email, telephone")
    .eq("id", referrerUserId)
    .single();

  if (referrerError) throw referrerError;
  if (!referrer) {
    return { created: false, reason: "referrer_not_found" };
  }

  const normalizedReferrerEmail = normalizeEmail(referrer.email);
  const normalizedReferredEmail = normalizeEmail(referredEmail);

  if (
    normalizedReferrerEmail &&
    normalizedReferredEmail &&
    normalizedReferrerEmail === normalizedReferredEmail
  ) {
    return { created: false, reason: "same_email" };
  }

  const normalizedReferrerPhone = String(referrer.telephone || "").trim();
  const normalizedReferredPhone = String(referredPhone || "").trim();

  if (
    normalizedReferrerPhone &&
    normalizedReferredPhone &&
    normalizedReferrerPhone === normalizedReferredPhone
  ) {
    return { created: false, reason: "same_phone" };
  }

  const { data: inserted, error: insertError } = await supabase
    .from("referrals")
    .insert({
      referrer_user_id: referrerUserId,
      referred_user_id: referredUserId,
      reservation_id: reservationId || null,
      referral_code_used: safeCode,
      status: REFERRAL_STATUSES.PENDING,
      reward_step_granted: 0,
    })
    .select()
    .single();

  if (insertError) {
    if (String(insertError.message || "").toLowerCase().includes("duplicate")) {
      return { created: false, reason: "duplicate" };
    }
    throw insertError;
  }

  return { created: true, reason: null, referral: inserted };
}

export async function markReferralCancelledByReservationId(
  reservationId,
  reason = "reservation_cancelled_or_refunded"
) {
  assertSupabaseConfigured();

  if (!reservationId) return null;

  const { data: referral, error: readError } = await supabase
    .from("referrals")
    .select("*")
    .eq("reservation_id", reservationId)
    .maybeSingle();

  if (readError) throw readError;
  if (!referral) return null;

  if (referral.status !== REFERRAL_STATUSES.PENDING) {
    return referral;
  }

  const { data, error } = await supabase
    .from("referrals")
    .update({
      status: REFERRAL_STATUSES.CANCELLED,
      rejection_reason: reason,
      cancelled_at: new Date().toISOString(),
    })
    .eq("id", referral.id)
    .select()
    .single();

  if (error) throw error;
  return data;
}

async function grantFreeSessionRewardIfEligible(referral) {
  const referrerUserId = referral.referrer_user_id;

  const { count, error: countError } = await supabase
    .from("referrals")
    .select("id", { count: "exact", head: true })
    .eq("referrer_user_id", referrerUserId)
    .eq("status", REFERRAL_STATUSES.VALIDATED);

  if (countError) throw countError;

  const validatedCount = Number(count || 0);

  if (validatedCount < REFERRAL_REQUIRED_VALID_COUNT) {
    return {
      granted: false,
      validatedCount,
      reason: "milestone_not_reached",
    };
  }

  const { data: existingReward, error: existingRewardError } = await supabase
    .from("referral_rewards")
    .select("*")
    .eq("user_id", referrerUserId)
    .eq("milestone", REFERRAL_REQUIRED_VALID_COUNT)
    .maybeSingle();

  if (existingRewardError) throw existingRewardError;

  if (existingReward) {
    return {
      granted: false,
      validatedCount,
      reason: "reward_already_exists",
      reward: existingReward,
    };
  }

  const { data: reward, error: rewardError } = await supabase
    .from("referral_rewards")
    .insert({
      user_id: referrerUserId,
      referral_id: referral.id,
      milestone: REFERRAL_REQUIRED_VALID_COUNT,
      reward_type: REFERRAL_REWARD_TYPES.FREE_SESSION_2P,
      reward_value: REFERRAL_FREE_SESSION_INCLUDED_PERSONS,
      status: REFERRAL_REWARD_STATUSES.AVAILABLE,
      metadata: {
        label: REFERRAL_SESSION_REWARD_LABEL,
        included_persons: REFERRAL_FREE_SESSION_INCLUDED_PERSONS,
      },
    })
    .select()
    .single();

  if (rewardError) throw rewardError;

  return {
    granted: true,
    validatedCount,
    reason: null,
    reward,
  };
}

export async function validateReferralByReservationId(reservationId) {
  assertSupabaseConfigured();

  if (!reservationId) {
    return { validated: false, reason: "missing_reservation_id" };
  }

  const { data: referral, error: referralError } = await supabase
    .from("referrals")
    .select("*")
    .eq("reservation_id", reservationId)
    .maybeSingle();

  if (referralError) throw referralError;
  if (!referral) {
    return { validated: false, reason: "referral_not_found" };
  }

  if (referral.status === REFERRAL_STATUSES.VALIDATED) {
    return { validated: false, reason: "already_validated", referral };
  }

  if (referral.status !== REFERRAL_STATUSES.PENDING) {
    return { validated: false, reason: "not_pending", referral };
  }

  const { data: reservation, error: reservationError } = await supabase
    .from("reservations")
    .select("id, status, cancelled_at, refunded_at, refunded_amount, completed_at")
    .eq("id", reservationId)
    .single();

  if (reservationError) throw reservationError;
  if (!reservation) {
    return { validated: false, reason: "reservation_not_found" };
  }

  const refundedAmount = Number(reservation.refunded_amount || 0);

  const isValid =
    String(reservation.status || "").trim().toLowerCase() === "completed" &&
    !reservation.cancelled_at &&
    !reservation.refunded_at &&
    refundedAmount <= 0 &&
    !!reservation.completed_at;

  if (!isValid) {
    return { validated: false, reason: "reservation_not_eligible", referral };
  }

  const { data: updatedReferral, error: updateError } = await supabase
    .from("referrals")
    .update({
      status: REFERRAL_STATUSES.VALIDATED,
      validated_at: new Date().toISOString(),
    })
    .eq("id", referral.id)
    .select()
    .single();

  if (updateError) throw updateError;

  const rewardResult = await grantFreeSessionRewardIfEligible(updatedReferral);

  return {
    validated: true,
    reason: null,
    referral: updatedReferral,
    rewardResult,
  };
}

export async function getAvailableFreeSessionReward(userId) {
  assertSupabaseConfigured();

  const { data, error } = await supabase
    .from("referral_rewards")
    .select("*")
    .eq("user_id", userId)
    .eq("reward_type", REFERRAL_REWARD_TYPES.FREE_SESSION_2P)
    .eq("status", REFERRAL_REWARD_STATUSES.AVAILABLE)
    .order("created_at", { ascending: true })
    .limit(1)
    .maybeSingle();

  if (error) throw error;
  return data || null;
}

export async function consumeFreeSessionReward({
  rewardId,
  reservationId,
}) {
  assertSupabaseConfigured();

  const { data: reward, error: readError } = await supabase
    .from("referral_rewards")
    .select("*")
    .eq("id", rewardId)
    .single();

  if (readError) throw readError;
  if (!reward) {
    throw new Error("Récompense de parrainage introuvable");
  }

  if (reward.status !== REFERRAL_REWARD_STATUSES.AVAILABLE) {
    throw new Error("Récompense de parrainage indisponible");
  }

  const metadata = {
    ...(reward.metadata || {}),
    used_on_reservation_id: reservationId || null,
  };

  const { data, error } = await supabase
    .from("referral_rewards")
    .update({
      status: REFERRAL_REWARD_STATUSES.USED,
      used_at: new Date().toISOString(),
      metadata,
    })
    .eq("id", rewardId)
    .select()
    .single();

  if (error) throw error;
  return data;
}