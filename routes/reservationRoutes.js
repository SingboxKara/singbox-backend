import express from "express";
import jwt from "jsonwebtoken";

import { supabase } from "../config/supabase.js";
import { stripe } from "../config/stripe.js";
import { JWT_SECRET } from "../config/env.js";
import { authMiddleware } from "../middlewares/auth.js";
import { requireAdminOrCron } from "../middlewares/admin.js";

import {
  buildTimesFromSlot,
  computeCartPricing,
  computeSessionCashAmount,
  computeModificationDelta,
  buildSlotIsoRange,
  STANDARD_SLOT_STARTS,
  getBillablePersons,
} from "../services/pricingService.js";

import {
  hasReservationConflict,
  isReservationStatusModifiable,
  isWithinModificationWindow,
  isWithinRefundWindow,
  updateReservationById,
  getReservationByGuestToken,
  generateGuestManageToken,
  normalizeReservationStatus,
  isPaymentIntentAlreadyUsed,
} from "../services/reservationService.js";

import {
  updateUserProfileInUsersTable,
  getReservationOwnedByUser,
} from "../services/userService.js";

import {
  isReservationPaidWithSingcoins,
  getReservationSingcoinsUsed,
  getReservationPersons,
  spendSingcoins,
  refundSingcoinsToUser,
} from "../services/singcoinService.js";

import {
  attemptAutomaticSavedCardCharge,
  attemptAutomaticRefundAcrossPaymentIntents,
} from "../services/stripeCustomerService.js";

import {
  creditSingcoins,
  getUserGamificationSnapshot,
  createGamificationEvent,
} from "../services/gamificationService.js";

import {
  ensureUserReferralCode,
  getUserByReferralCode,
  createPendingReferralForReservation,
  validateReferralByReservationId,
  markReferralCancelledByReservationId,
  getUserReferralSummary,
  getAvailableFreeSessionReward,
  consumeFreeSessionReward,
} from "../services/referralService.js";

import {
  safeText,
  clampPersons,
  getNumericBoxId,
} from "../utils/validators.js";
import { parseDateOrNull, formatDateToYYYYMMDD } from "../utils/dates.js";
import { roundMoney } from "../utils/formatters.js";
import {
  MODIFICATION_DEADLINE_HOURS,
  REFUND_DEADLINE_HOURS,
  SLOT_DURATION_MINUTES,
  SINGCOINS_REWARD_COST,
} from "../constants/booking.js";
import {
  REFERRAL_REQUIRED_VALID_COUNT,
  REFERRAL_FREE_SESSION_INCLUDED_PERSONS,
} from "../constants/referral.js";

import {
  sendReservationEmail,
  sendReservationModificationEmail,
} from "../services/emailService.js";
import { validatePromoCode } from "../services/promoService.js";

const router = express.Router();

/* =========================================================
   HELPERS
========================================================= */

function normalizeEmail(email) {
  return String(email || "").trim().toLowerCase();
}

function buildGuestReservationResponse(reservation) {
  return {
    reservation: {
      id: reservation?.id ?? null,
      name: reservation?.name ?? null,
      email: reservation?.email ?? null,
      date: reservation?.date ?? null,
      start_time: reservation?.start_time ?? null,
      end_time: reservation?.end_time ?? null,
      box_id: reservation?.box_id ?? null,
      persons: reservation?.persons ?? null,
      status: reservation?.status ?? null,
      montant: reservation?.montant ?? null,
      free_session: reservation?.free_session ?? false,
    },
    accessMode: "guest",
    rules: {
      modificationDeadlineHours: MODIFICATION_DEADLINE_HOURS,
      refundDeadlineHours: REFUND_DEADLINE_HOURS,
      canModify: isWithinModificationWindow(reservation.start_time),
      canRefund: isWithinRefundWindow(reservation.start_time),
    },
  };
}

function buildFullName(customer) {
  const prenom = String(customer?.prenom || "").trim();
  const nom = String(customer?.nom || "").trim();
  return `${prenom}${prenom && nom ? " " : ""}${nom}`.trim();
}

async function isFirstReservationForEmail(email) {
  const safeEmail = normalizeEmail(email);
  if (!safeEmail || !supabase) return null;

  const { data, error } = await supabase
    .from("reservations")
    .select("id, status")
    .eq("email", safeEmail)
    .limit(20);

  if (error) {
    console.error("Erreur vérification première réservation :", error);
    return null;
  }

  const activeReservations = (data || []).filter((row) => {
    const status = normalizeReservationStatus(row.status);
    return ![
      "cancelled",
      "annulee",
      "annulée",
      "refunded",
      "remboursee",
      "remboursée",
    ].includes(status);
  });

  return activeReservations.length === 0;
}

async function invalidateGuestManageToken(reservationId) {
  if (!supabase || !reservationId) return;

  try {
    await updateReservationById(reservationId, {
      guest_manage_token: generateGuestManageToken(),
      guest_manage_token_created_at: new Date().toISOString(),
      guest_manage_token_expires_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });
  } catch (e) {
    console.error("Erreur invalidation guest_manage_token :", e);
  }
}

async function findUserIdByEmail(email) {
  const safeEmail = normalizeEmail(email);
  if (!supabase || !safeEmail) return null;

  try {
    const { data, error } = await supabase
      .from("users")
      .select("id")
      .eq("email", safeEmail)
      .maybeSingle();

    if (error) {
      console.error("findUserIdByEmail error:", error);
      return null;
    }

    return data?.id || null;
  } catch (e) {
    console.error("findUserIdByEmail catch:", e);
    return null;
  }
}

async function resolveReservationUserId({ explicitUserId = null, email = null }) {
  if (explicitUserId) return explicitUserId;
  if (!email) return null;
  return await findUserIdByEmail(email);
}

async function resolveReferralContext({
  referralCode,
  resolvedUserId,
  normalizedCustomerEmail,
  customer,
}) {
  const safeReferralCode = String(referralCode || "").trim().toUpperCase();
  if (!safeReferralCode) {
    return { ok: true, referralCode: null, referrer: null };
  }

  if (!resolvedUserId) {
    return {
      ok: false,
      reason: "Connexion requise pour attacher un parrainage à un compte client",
    };
  }

  const referrer = await getUserByReferralCode(safeReferralCode);

  if (!referrer) {
    return {
      ok: false,
      reason: "Code de parrainage introuvable",
    };
  }

  if (referrer.id === resolvedUserId) {
    return {
      ok: false,
      reason: "Tu ne peux pas utiliser ton propre code de parrainage",
    };
  }

  if (
    String(referrer.email || "").trim().toLowerCase() === normalizedCustomerEmail
  ) {
    return {
      ok: false,
      reason: "Ce code de parrainage ne peut pas être utilisé sur le même email",
    };
  }

  const customerPhone = String(customer?.telephone || "").trim();
  const referrerPhone = String(referrer.telephone || "").trim();

  if (customerPhone && referrerPhone && customerPhone === referrerPhone) {
    return {
      ok: false,
      reason: "Ce code de parrainage ne peut pas être utilisé avec le même téléphone",
    };
  }

  return {
    ok: true,
    referralCode: safeReferralCode,
    referrer,
  };
}

async function safeCreateReservationGamificationEvent(reservation) {
  try {
    if (!supabase || !reservation?.id || !reservation?.user_id) {
      return {
        created: false,
        skipped: true,
        reason: "missing_user_or_reservation",
      };
    }

    const referenceId = String(reservation.id);

    const { data: existingEvent, error: existingError } = await supabase
      .from("gamification_events")
      .select("id")
      .eq("user_id", reservation.user_id)
      .eq("event_type", "reservation_created")
      .eq("reference_type", "reservation")
      .eq("reference_id", referenceId)
      .maybeSingle();

    if (existingError) {
      console.error(
        "safeCreateReservationGamificationEvent check error:",
        existingError
      );
    }

    if (existingEvent?.id) {
      return {
        created: false,
        skipped: true,
        reason: "already_exists",
      };
    }

    await createGamificationEvent({
      user_id: reservation.user_id,
      event_type: "reservation_created",
      reference_type: "reservation",
      reference_id: referenceId,
      payload: {
        reservation_id: reservation.id,
        persons: Number(reservation.persons || 0),
        billable_persons: Number(reservation.billable_persons || 0),
        is_group: !!reservation.is_group_session,
        is_weekend: !!reservation.is_weekend,
        is_daytime: !!reservation.is_daytime,
        session_minutes: Number(reservation.session_minutes || 0),
        amount: Number(reservation.montant || 0),
        free_session: !!reservation.free_session,
        created_at: reservation.created_at || new Date().toISOString(),
      },
    });

    return {
      created: true,
      skipped: false,
      reason: null,
    };
  } catch (gErr) {
    console.error("safeCreateReservationGamificationEvent create error:", gErr);
    return {
      created: false,
      skipped: false,
      reason: "create_failed",
      error: gErr,
    };
  }
}

function buildReservationRow({
  item,
  fullName,
  normalizedCustomerEmail,
  resolvedUserId,
  singcoinsUsed,
  paymentIntentId,
  referralFreeSessionApplied = false,
}) {
  const start = new Date(item.start_time);
  const end = new Date(item.end_time);
  const hour = start.getHours();
  const day = start.getDay();
  const nowIso = new Date().toISOString();

  const lineAmount = Number(item.cashAmountDue || 0);
  const lineTheoreticalFullAmount = Number(item.theoreticalFullAmount || lineAmount);
  const lineSingcoinsDiscountAmount = Number(item.singcoinsDiscountAmount || 0);

  return {
    name: fullName,
    email: normalizedCustomerEmail,
    user_id: resolvedUserId || null,

    datetime: start.toISOString(),
    created_at: nowIso,
    start_time: start.toISOString(),
    end_time: end.toISOString(),
    date: item.date,

    box_id: item.box_id,
    status: "confirmed",

    persons: item.persons,
    billable_persons: getBillablePersons(item.persons),

    montant: lineAmount,
    free_session: referralFreeSessionApplied ? true : lineAmount <= 0,

    payment_intent_id: paymentIntentId || null,
    original_payment_intent_id: paymentIntentId || null,
    latest_payment_intent_id: paymentIntentId || null,

    singcoins_used: !!singcoinsUsed,
    singcoins_spent: singcoinsUsed ? SINGCOINS_REWARD_COST : 0,

    promo_code: item.promoCode || null,
    promo_discount_amount: Number(item.promoDiscountAmount || 0),

    theoretical_full_amount: lineTheoreticalFullAmount,
    singcoins_discount_amount: lineSingcoinsDiscountAmount,

    is_weekend: day === 0 || day === 6,
    is_daytime: hour >= 12 && hour < 18,
    is_group_session: Number(item.persons || 0) >= 3,
    session_minutes: Math.max(
      0,
      Math.round((end.getTime() - start.getTime()) / 60000)
    ),
  };
}

async function persistReservations(rows) {
  const { data, error } = await supabase
    .from("reservations")
    .insert(rows)
    .select("*");

  if (error) {
    console.error("Erreur insertion réservations :", error);
    return null;
  }

  return data || [];
}

async function markPaymentIntentReservations(paymentIntentId, reservationIds = []) {
  if (!paymentIntentId || !reservationIds.length) return;

  try {
    await stripe.paymentIntents.update(paymentIntentId, {
      metadata: {
        reservation_ids: reservationIds.map(String).join(","),
      },
    });
  } catch (e) {
    console.error("Erreur update metadata paymentIntent:", e);
  }
}

async function sendReservationEmailsSafe(reservations, customer) {
  if (!Array.isArray(reservations) || reservations.length === 0) return;

  for (const reservation of reservations) {
    try {
      await sendReservationEmail(reservation, customer);
    } catch (e) {
      console.error("Erreur envoi mail réservation :", e);
    }
  }
}

async function ensureGuestTokenOnReservations(reservations = []) {
  if (!Array.isArray(reservations) || reservations.length === 0) {
    return reservations;
  }

  const updatedReservations = [];

  for (const reservation of reservations) {
    if (!reservation?.id) {
      updatedReservations.push(reservation);
      continue;
    }

    if (reservation.guest_manage_token && reservation.guest_manage_token_expires_at) {
      updatedReservations.push(reservation);
      continue;
    }

    const token = generateGuestManageToken();
    const createdAt = new Date().toISOString();
    const expiresAt = new Date(Date.now() + 1000 * 60 * 60 * 24 * 30).toISOString();

    try {
      const updated = await updateReservationById(reservation.id, {
        guest_manage_token: token,
        guest_manage_token_created_at: createdAt,
        guest_manage_token_expires_at: expiresAt,
      });

      updatedReservations.push(updated || reservation);
    } catch (e) {
      console.error("Erreur création guest_manage_token :", e);
      updatedReservations.push(reservation);
    }
  }

  return updatedReservations;
}

async function buildReservationAccessToken(reservation) {
  if (!reservation?.id || !reservation?.email) return null;

  try {
    return jwt.sign(
      {
        reservationId: reservation.id,
        email: normalizeEmail(reservation.email),
        mode: "guest",
      },
      JWT_SECRET,
      { expiresIn: "30d" }
    );
  } catch (e) {
    console.error("Erreur génération reservation access token :", e);
    return null;
  }
}

async function attachPaymentIntentToModificationRequest({
  modReqId,
  paymentIntentId,
  clientSecret,
}) {
  if (!modReqId || !paymentIntentId || !clientSecret || !supabase) return false;

  const { error } = await supabase
    .from("reservation_modification_requests")
    .update({
      stripe_payment_intent_id: paymentIntentId,
      stripe_client_secret: clientSecret,
      updated_at: new Date().toISOString(),
    })
    .eq("id", modReqId);

  if (error) {
    console.error("Erreur liaison PaymentIntent -> modification request :", error);
    return false;
  }

  return true;
}

async function createPendingModificationRequest({
  reservation,
  oldAmount,
  newAmount,
  deltaAmount,
  targetStart,
  targetEnd,
  safePersons,
  targetBoxId,
  stripePaymentIntentId = null,
  stripeClientSecret = null,
}) {
  if (!supabase || !reservation?.id) return null;

  const payload = {
    reservation_id: reservation.id,
    old_start_time: reservation.start_time,
    old_end_time: reservation.end_time,
    old_persons: Number(reservation.persons || 2),
    old_amount: Number(oldAmount || 0),

    new_start_time: targetStart.toISOString(),
    new_end_time: targetEnd.toISOString(),
    new_persons: Number(safePersons || 2),
    new_amount: Number(newAmount || 0),

    delta_amount: Number(deltaAmount || 0),
    box_id: Number(targetBoxId || reservation.box_id || 1),

    singcoins_used: !!isReservationPaidWithSingcoins(reservation),
    singcoins_spent: isReservationPaidWithSingcoins(reservation)
      ? Number(getReservationSingcoinsUsed(reservation))
      : 0,

    stripe_payment_intent_id: stripePaymentIntentId,
    stripe_client_secret: stripeClientSecret,

    status: "pending",
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };

  const { data, error } = await supabase
    .from("reservation_modification_requests")
    .insert(payload)
    .select("*")
    .single();

  if (error) {
    console.error("Erreur création reservation_modification_requests :", error);
    return null;
  }

  return data;
}

async function createReservationsFromCart({
  cartItems,
  customer,
  userId = null,
  singcoinsUsed = false,
  paymentIntentId = null,
  referralFreeSessionApplied = false,
}) {
  const normalizedCustomerEmail = normalizeEmail(customer?.email);
  const fullName = buildFullName(customer);
  const resolvedUserId = await resolveReservationUserId({
    explicitUserId: userId,
    email: normalizedCustomerEmail,
  });

  const rows = cartItems.map((item) =>
    buildReservationRow({
      item,
      fullName,
      normalizedCustomerEmail,
      resolvedUserId,
      singcoinsUsed,
      paymentIntentId,
      referralFreeSessionApplied,
    })
  );

  const reservations = await persistReservations(rows);
  if (!reservations) return null;

  return await ensureGuestTokenOnReservations(reservations);
}

async function handleReferralAfterReservationCreation({
  reservations,
  referralContext,
  userId,
  customerEmail,
}) {
  if (!Array.isArray(reservations) || reservations.length === 0) {
    return;
  }

  if (!referralContext?.referralCode || !referralContext?.referrer || !userId) {
    return;
  }

  for (const reservation of reservations) {
    try {
      await createPendingReferralForReservation({
        reservationId: reservation.id,
        referrerUserId: referralContext.referrer.id,
        referredUserId: userId,
        referredEmail: customerEmail,
        referralCode: referralContext.referralCode,
      });
    } catch (err) {
      console.error("Erreur création pending referral :", err);
    }
  }
}

async function maybeValidateReferralAfterCompletion(reservation) {
  if (!reservation?.id) return;

  try {
    await validateReferralByReservationId(reservation.id);
  } catch (e) {
    console.error("Erreur validation referral après completion :", e);
  }
}

async function maybeCancelReferralAfterCancellation(reservationId) {
  if (!reservationId) return;

  try {
    await markReferralCancelledByReservationId(reservationId);
  } catch (e) {
    console.error("Erreur annulation referral après annulation réservation :", e);
  }
}

async function consumeReferralRewardIfNeeded({
  resolvedUserId,
  totalPersons,
}) {
  if (!resolvedUserId) {
    return {
      applied: false,
      reward: null,
    };
  }

  const validSummary = await getUserReferralSummary(resolvedUserId);
  const validCount = Number(validSummary?.validCount || 0);

  if (validCount < REFERRAL_REQUIRED_VALID_COUNT) {
    return {
      applied: false,
      reward: null,
    };
  }

  const reward = await getAvailableFreeSessionReward(resolvedUserId);
  if (!reward) {
    return {
      applied: false,
      reward: null,
    };
  }

  const persons = Number(totalPersons || 0);
  if (persons > REFERRAL_FREE_SESSION_INCLUDED_PERSONS) {
    return {
      applied: false,
      reward: null,
    };
  }

  const consumed = await consumeFreeSessionReward(reward.id);
  if (!consumed) {
    return {
      applied: false,
      reward: null,
    };
  }

  return {
    applied: true,
    reward,
  };
}

function sumCartPersons(cart = []) {
  return (Array.isArray(cart) ? cart : []).reduce(
    (sum, item) => sum + Number(item?.persons || 0),
    0
  );
}

/* =========================================================
   PUBLIC CHECK CART
========================================================= */

router.post("/api/verify-cart", async (req, res) => {
  try {
    const body = req.body || {};
    const cart = Array.isArray(body.cart) ? body.cart : [];
    const promoCode = safeText(body.promoCode, 80) || null;
    const singcoinsUsed = body.singcoinsUsed === true;
    const customer = body.customer || null;

    if (cart.length === 0) {
      return res.status(400).json({ error: "Panier vide" });
    }

    const pricing = await computeCartPricing({
      cart,
      singcoinsUsed,
      promoCode,
      customer,
    });

    return res.json({
      success: true,
      pricing,
    });
  } catch (error) {
    console.error("Erreur /api/verify-cart :", error);
    return res.status(500).json({ error: "Erreur serveur" });
  }
});

/* =========================================================
   CONFIRM RESERVATION
========================================================= */

router.post("/api/confirm-reservation", async (req, res) => {
  try {
    const body = req.body || {};
    const cart = Array.isArray(body.cart) ? body.cart : [];
    const customer = body.customer || {};
    const promoCode = safeText(body.promoCode, 80) || null;
    const referralCodeRaw = safeText(body.referralCode, 80) || null;
  