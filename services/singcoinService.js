// backend/services/singcoinService.js

import { SINGCOINS_REWARD_COST } from "../constants/booking.js";
import {
  debitSingcoins,
  refundSingcoins,
  getAvailableSingcoinsForUser,
} from "./gamificationService.js";

export function isReservationPaidWithSingcoins(reservation) {
  if (reservation?.loyalty_used === true) return true;

  const pointsSpent = Number(reservation?.points_spent || 0);
  if (Number.isFinite(pointsSpent) && pointsSpent >= SINGCOINS_REWARD_COST) return true;

  const freeSession = reservation?.free_session === true;
  const montant = Number(reservation?.montant || 0);
  const hasNoPaymentIntent = !reservation?.payment_intent_id;
  const hasNoPromo = !String(reservation?.promo_code || "").trim();

  if (freeSession && montant === 0 && hasNoPaymentIntent && hasNoPromo) {
    return true;
  }

  return false;
}

export function getReservationSingcoinsUsed(reservation) {
  const n = Number(reservation?.points_spent);
  if (Number.isFinite(n) && n > 0) return n;

  return isReservationPaidWithSingcoins(reservation)
    ? SINGCOINS_REWARD_COST
    : 0;
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

export async function getAvailableSingcoins(userId) {
  return getAvailableSingcoinsForUser(userId);
}

export async function spendSingcoins(userId, amount) {
  const result = await debitSingcoins({
    userId,
    amount,
    type: "singcoins_spend",
    referenceType: "singcoins",
    referenceId: `singcoins-spend:${Date.now()}`,
    label: "Utilisation Singcoins Singbox",
  });

  if (!result.success) {
    return {
      success: false,
      reason: result.reason || "Pas assez de Singcoins",
      current: result.currentSingcoins ?? 0,
      required: result.requiredSingcoins ?? amount,
    };
  }

  return {
    success: true,
    deducted: result.deducted,
    remaining: result.remainingSingcoins,
  };
}

export async function refundSingcoinsToUser(userId, amount) {
  return refundSingcoins({
    userId,
    amount,
    type: "singcoins_refund",
    referenceType: "singcoins",
    referenceId: `singcoins-refund:${Date.now()}`,
    label: "Remboursement Singcoins Singbox",
  });
}