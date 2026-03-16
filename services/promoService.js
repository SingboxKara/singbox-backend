// backend/services/loyaltyService.js

import { supabase } from "../config/supabase.js";
import { LOYALTY_POINTS_COST } from "../constants/booking.js";
import { getUserById } from "./userService.js";

export function isReservationPaidWithLoyalty(reservation) {
  if (reservation?.loyalty_used === true) return true;

  const pointsSpent = Number(reservation?.points_spent || 0);
  if (Number.isFinite(pointsSpent) && pointsSpent >= LOYALTY_POINTS_COST) return true;

  const freeSession = reservation?.free_session === true;
  const montant = Number(reservation?.montant || 0);
  const hasNoPaymentIntent = !reservation?.payment_intent_id;
  const hasNoPromo = !String(reservation?.promo_code || "").trim();

  if (freeSession && montant === 0 && hasNoPaymentIntent && hasNoPromo) {
    return true;
  }

  return false;
}

export function getReservationLoyaltyPointsUsed(reservation) {
  const n = Number(reservation?.points_spent);
  if (Number.isFinite(n) && n > 0) return n;
  return isReservationPaidWithLoyalty(reservation) ? LOYALTY_POINTS_COST : 0;
}

export function getReservationPersons(reservation) {
  const n = Number(reservation?.persons);
  if (Number.isFinite(n) && n >= 1 && n <= 8) {
    return n;
  }
  return 2;
}

export function getReservationAmountPaid(reservation) {
  const n = Number(reservation?.montant);
  if (Number.isFinite(n)) return n;
  return 0;
}

export async function consumeLoyaltyPointsForUser(userId, pointsToSpend) {
  if (!supabase) throw new Error("Supabase non configuré");
  if (!pointsToSpend || pointsToSpend <= 0) {
    return { success: true, deducted: 0 };
  }

  const { data: user, error: userErr } = await supabase
    .from("users")
    .select("id, points")
    .eq("id", userId)
    .single();

  if (userErr || !user) {
    throw new Error("Utilisateur introuvable pour débit fidélité");
  }

  const currentPoints = Number(user.points || 0);
  if (currentPoints < pointsToSpend) {
    return {
      success: false,
      reason: "Pas assez de points de fidélité",
      currentPoints,
      requiredPoints: pointsToSpend,
    };
  }

  const newPoints = currentPoints - pointsToSpend;

  const { error: updateErr } = await supabase
    .from("users")
    .update({
      points: newPoints,
      updated_at: new Date().toISOString(),
    })
    .eq("id", userId);

  if (updateErr) {
    throw updateErr;
  }

  return {
    success: true,
    deducted: pointsToSpend,
    remainingPoints: newPoints,
  };
}

export async function refundPointsToUser(userId, pointsToRefund) {
  if (!supabase) throw new Error("Supabase non configuré");
  if (!pointsToRefund || pointsToRefund <= 0) return;

  const user = await getUserById(userId);
  const currentPoints = Number(user.points || 0);

  const { error } = await supabase
    .from("users")
    .update({
      points: currentPoints + pointsToRefund,
      updated_at: new Date().toISOString(),
    })
    .eq("id", userId);

  if (error) throw error;
}