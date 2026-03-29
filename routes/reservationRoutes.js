import express from "express";
import jwt from "jsonwebtoken";

import { supabase } from "../config/supabase.js";
import { stripe } from "../config/stripe.js";
import { JWT_SECRET } from "../config/env.js";
import {
  authMiddleware,
  optionalAuthMiddleware,
} from "../middlewares/auth.js";
import {
  requireAdminOrCron,
  requireSupabaseAdmin,
} from "../middlewares/admin.js";

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
  getReservationById,
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
  ensureStripeCustomer,
} from "../services/stripeCustomerService.js";

import {
  creditSingcoins,
  getUserGamificationSnapshot,
  createGamificationEvent,
  processReservationGamification,
  getAvailableSingcoinsForUser,
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

import { safeText, clampPersons } from "../utils/validators.js";
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

import {
  sendReviewRequestEmail,
  getExistingReviewRequestByReservationId,
} from "../services/reviewService.js";
import { validatePromoCode } from "../services/promoService.js";

const router = express.Router();

/* =========================================================
   HELPERS
========================================================= */

function normalizeEmail(email) {
  return String(email || "").trim().toLowerCase();
}

function isCancelledOrRefundedStatus(statusRaw) {
  const status = normalizeReservationStatus(statusRaw);
  return [
    "cancelled",
    "annulee",
    "annulée",
    "refunded",
    "remboursee",
    "remboursée",
  ].includes(status);
}

function isCompletedStatus(statusRaw) {
  return normalizeReservationStatus(statusRaw) === "completed";
}

function isPassReservation(reservation) {
  return (
    reservation?.paid_with_pass === true ||
    !!reservation?.user_pass_id ||
    Number(reservation?.pass_places_used || 0) > 0
  );
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
      paid_with_pass: reservation?.paid_with_pass ?? false,
      user_pass_id: reservation?.user_pass_id ?? null,
      pass_places_used: reservation?.pass_places_used ?? 0,
      pass_type: reservation?.pass_type ?? null,
    },
    accessMode: "guest",
    rules: {
      modificationDeadlineHours: MODIFICATION_DEADLINE_HOURS,
      refundDeadlineHours: REFUND_DEADLINE_HOURS,
      canModify: isWithinModificationWindow(reservation.start_time),
      canRefund:
        isPassReservation(reservation)
          ? false
          : isWithinRefundWindow(reservation.start_time),
    },
  };
}

function buildFullName(customer) {
  const prenom = String(customer?.prenom || "").trim();
  const nom = String(customer?.nom || "").trim();
  return `${prenom}${prenom && nom ? " " : ""}${nom}`.trim();
}

function buildPromoPayload(promo) {
  return promo
    ? {
        id: promo.id ?? null,
        code: promo.code ?? null,
        type: promo.type ?? null,
        value: promo.value ?? null,
      }
    : null;
}

function round2(value) {
  const n = Number(value || 0);
  return Number(n.toFixed(2));
}

function verifyExpressRebookToken(rawToken) {
  const safeToken = String(rawToken || "").trim();
  if (!safeToken) {
    throw new Error("Token de rebooking manquant");
  }

  const payload = jwt.verify(safeToken, JWT_SECRET);
  if (payload?.type !== "express_rebook") {
    throw new Error("Token de rebooking invalide");
  }

  return {
    reservationId: String(payload?.reservationId || "").trim(),
    userId: String(payload?.userId || "").trim() || null,
    email: normalizeEmail(payload?.email || "") || null,
  };
}

function addDaysToIso(isoString, days) {
  const date = new Date(isoString);
  if (Number.isNaN(date.getTime())) {
    throw new Error("Date ISO invalide");
  }

  date.setUTCDate(date.getUTCDate() + Number(days || 0));
  return date.toISOString();
}

function buildExpressRebookCartFromReservation(reservation, overrides = {}) {
  const persons = clampPersons(overrides?.persons ?? reservation?.persons ?? 2);
  const boxId = Number(
    overrides?.box_id ?? overrides?.boxId ?? reservation?.box_id ?? 1
  );
  const startTime =
    overrides?.start_time || addDaysToIso(reservation.start_time, 7);
  const endTime =
    overrides?.end_time || addDaysToIso(reservation.end_time, 7);
  const startDate = new Date(startTime);

  return [
    {
      box_id: boxId,
      persons,
      start_time: startTime,
      end_time: endTime,
      date: formatDateToYYYYMMDD(startDate),
    },
  ];
}

async function listExpressRebookAlternatives(reservation, { max = 3 } = {}) {
  const sourceStart = new Date(reservation?.start_time);
  if (Number.isNaN(sourceStart.getTime())) return [];

  const targetDate = formatDateToYYYYMMDD(
    new Date(addDaysToIso(reservation.start_time, 7))
  );
  const sourceHourFloat =
    sourceStart.getHours() + sourceStart.getMinutes() / 60;

  const preferredHours = [
    sourceHourFloat,
    sourceHourFloat - 0.5,
    sourceHourFloat + 0.5,
    sourceHourFloat - 1,
    sourceHourFloat + 1,
    sourceHourFloat - 1.5,
    sourceHourFloat + 1.5,
  ];

  const validHours = preferredHours.filter((hour) =>
    STANDARD_SLOT_STARTS.some((slotHour) => Number(slotHour) === Number(hour))
  );

  const uniqueHours = [...new Set(validHours)];
  const alternatives = [];

  for (const hour of uniqueHours) {
    if (alternatives.length >= max) break;
    const range = buildSlotIsoRange(targetDate, hour);
    const conflict = await hasReservationConflict({
      boxId: reservation.box_id,
      startTime: range.startIso,
      endTime: range.endIso,
      localDate: targetDate,
    });

    if (!conflict) {
      alternatives.push({
        box_id: reservation.box_id,
        persons: clampPersons(reservation.persons || 2),
        start_time: range.startIso,
        end_time: range.endIso,
        date: targetDate,
      });
    }
  }

  return alternatives;
}

async function resolveExpressRebookContext(rawToken) {
  const tokenData = verifyExpressRebookToken(rawToken);
  const fetchedReservation = await getReservationById(tokenData.reservationId);

  if (!fetchedReservation?.id) {
    throw new Error("Réservation source introuvable");
  }

  const reservationEmail = normalizeEmail(fetchedReservation.email);
  if (
    tokenData.email &&
    reservationEmail &&
    tokenData.email !== reservationEmail
  ) {
    throw new Error("Token et réservation non cohérents");
  }

  const userId = fetchedReservation.user_id || tokenData.userId || null;
  if (!userId) {
    throw new Error("Cette réservation n’est liée à aucun compte client");
  }

  const user = await getUserById(userId);
  if (!user?.id) {
    throw new Error("Compte client introuvable");
  }

  return { tokenData, reservation: fetchedReservation, user };
}

function formatExpressSlotLabel(slot) {
  const start = new Date(slot?.start_time);
  const end = new Date(slot?.end_time);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()))
    return "Créneau";
  const datePart = start.toLocaleDateString("fr-FR", {
    timeZone: "Europe/Paris",
    weekday: "long",
    day: "2-digit",
    month: "2-digit",
  });
  const timePart = `${start.toLocaleTimeString("fr-FR", {
    timeZone: "Europe/Paris",
    hour: "2-digit",
    minute: "2-digit",
  })} - ${end.toLocaleTimeString("fr-FR", {
    timeZone: "Europe/Paris",
    hour: "2-digit",
    minute: "2-digit",
  })}`;
  return `${datePart} · ${timePart}`;
}

function readExpressRequestedSlot(body = {}) {
  const requested = body?.requestedSlot || body?.slot || {};
  const start_time = safeText(requested?.start_time, 80) || null;
  const end_time = safeText(requested?.end_time, 80) || null;
  const box_id = Number(requested?.box_id ?? requested?.boxId ?? 0) || null;
  const persons = clampPersons(requested?.persons ?? body?.persons ?? 2);

  if (!start_time || !end_time || !box_id) return null;

  const start = new Date(start_time);
  return {
    start_time,
    end_time,
    box_id,
    persons,
    date: formatDateToYYYYMMDD(start),
  };
}

function readPaymentIntentIdsFromBody(body = {}) {
  return [
    safeText(body?.paymentIntentId, 200),
    safeText(body?.depositPaymentIntentId, 200),
  ].filter(Boolean);
}

async function refundExpressPaymentIntents(paymentIntentIds = []) {
  const results = [];
  for (const id of paymentIntentIds) {
    const result = await attemptAutomaticRefundAcrossPaymentIntents(
      {
        payment_intent_id: id,
        original_payment_intent_id: id,
        latest_payment_intent_id: id,
      },
      999999
    );
    results.push({ id, result });
  }
  return results;
}

function readCartFromBody(body) {
  if (Array.isArray(body?.cart)) return body.cart;
  if (Array.isArray(body?.panier)) return body.panier;
  return [];
}

function buildPromoValidationContext({ email, cart }) {
  return {
    email: normalizeEmail(email) || null,
    panier: Array.isArray(cart) ? cart : [],
  };
}

function distributeDiscountAcrossItems(items, totalDiscount, fieldName) {
  const safeItems = Array.isArray(items) ? items : [];
  const safeDiscount = round2(totalDiscount);

  if (!safeItems.length || safeDiscount <= 0) {
    return safeItems.map((item) => ({
      ...item,
      [fieldName]: round2(item?.[fieldName] || 0),
    }));
  }

  const totalCash = round2(
    safeItems.reduce((sum, item) => sum + Number(item.cashAmountDue || 0), 0)
  );

  if (totalCash <= 0) {
    return safeItems.map((item, index) => ({
      ...item,
      [fieldName]: index === 0 ? safeDiscount : 0,
    }));
  }

  let allocated = 0;

  return safeItems.map((item, index) => {
    const lineCash = round2(item.cashAmountDue || 0);

    let lineDiscount = 0;
    if (index === safeItems.length - 1) {
      lineDiscount = round2(safeDiscount - allocated);
    } else {
      lineDiscount = round2((lineCash / totalCash) * safeDiscount);
      allocated = round2(allocated + lineDiscount);
    }

    return {
      ...item,
      [fieldName]: lineDiscount,
    };
  });
}

async function computeReservationCartPricing({
  cart,
  singcoinsUsed = false,
  promoCode = null,
  customer = null,
  referralFreeSessionApplied = false,
}) {
  const basePricing = computeCartPricing(Array.isArray(cart) ? cart : [], {
    singcoinsUsed: !!singcoinsUsed,
  });

  let items = (basePricing.normalizedItems || []).map((item) => ({
    ...item,
    promoCode: null,
    promoDiscountAmount: 0,
    referralFreeSessionDiscountAmount: 0,
  }));

  const totalBeforeDiscount = round2(basePricing.totalBeforeDiscount || 0);
  const singcoinsDiscount = round2(basePricing.singcoinsDiscount || 0);

  let promoDiscountAmount = 0;
  let referralFreeSessionDiscountAmount = 0;
  let appliedPromo = null;
  let totalCashDue = round2(basePricing.totalCashDue || 0);

  if (promoCode) {
    const promoResult = await validatePromoCode(
      promoCode,
      totalCashDue,
      buildPromoValidationContext({
        email: customer?.email,
        cart,
      })
    );

    if (promoResult?.ok) {
      promoDiscountAmount = round2(promoResult.discountAmount || 0);
      totalCashDue = round2(promoResult.newTotal ?? totalCashDue);
      appliedPromo = promoResult.promo || promoResult.promoPublic || null;

      items = distributeDiscountAcrossItems(
        items,
        promoDiscountAmount,
        "promoDiscountAmount"
      ).map((item) => ({
        ...item,
        promoCode: appliedPromo?.code || safeText(promoCode, 80) || null,
        cashAmountDue: round2(
          Number(item.cashAmountDue || 0) -
            Number(item.promoDiscountAmount || 0)
        ),
      }));
    }
  }

  if (referralFreeSessionApplied) {
    referralFreeSessionDiscountAmount = round2(
      items.reduce((sum, item) => sum + Number(item.cashAmountDue || 0), 0)
    );

    items = items.map((item) => ({
      ...item,
      referralFreeSessionDiscountAmount: round2(item.cashAmountDue || 0),
      cashAmountDue: 0,
    }));

    totalCashDue = 0;
  }

  items = items.map((item) => ({
    ...item,
    theoreticalFullAmount: round2(item.theoreticalFullAmount || 0),
    singcoinsDiscountAmount: round2(item.singcoinsDiscountAmount || 0),
    promoDiscountAmount: round2(item.promoDiscountAmount || 0),
    referralFreeSessionDiscountAmount: round2(
      item.referralFreeSessionDiscountAmount || 0
    ),
    cashAmountDue: round2(Math.max(0, Number(item.cashAmountDue || 0))),
  }));

  return {
    success: true,
    items,
    normalizedItems: items,
    totalBeforeDiscount,
    singcoinsDiscount,
    promoDiscountAmount: round2(promoDiscountAmount),
    referralFreeSessionDiscountAmount: round2(
      referralFreeSessionDiscountAmount
    ),
    totalCashDue: round2(totalCashDue),
    totalAfterDiscount: round2(totalCashDue),
    promo: buildPromoPayload(appliedPromo),
  };
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

async function resolveReservationUserId({
  explicitUserId = null,
  email = null,
}) {
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
  const safeReferralCode = String(referralCode || "")
    .trim()
    .toUpperCase();
  if (!safeReferralCode) {
    return { ok: true, referralCode: null, referrer: null };
  }

  if (!resolvedUserId) {
    return {
      ok: false,
      reason:
        "Connexion requise pour attacher un parrainage à un compte client",
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
    String(referrer.email || "").trim().toLowerCase() ===
    normalizedCustomerEmail
  ) {
    return {
      ok: false,
      reason:
        "Ce code de parrainage ne peut pas être utilisé sur le même email",
    };
  }

  const customerPhone = String(customer?.telephone || "").trim();
  const referrerPhone = String(referrer.telephone || "").trim();

  if (customerPhone && referrerPhone && customerPhone === referrerPhone) {
    return {
      ok: false,
      reason:
        "Ce code de parrainage ne peut pas être utilisé avec le même téléphone",
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
  const lineTheoreticalFullAmount = Number(
    item.theoreticalFullAmount || lineAmount
  );
  const lineSingcoinsDiscountAmount = Number(
    item.singcoinsDiscountAmount || 0
  );

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

async function markPaymentIntentReservations(
  paymentIntentId,
  reservationIds = []
) {
  if (!paymentIntentId || !reservationIds.length || !stripe) return;

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

    if (
      reservation.guest_manage_token &&
      reservation.guest_manage_token_expires_at
    ) {
      updatedReservations.push(reservation);
      continue;
    }

    const token = generateGuestManageToken();
    const createdAt = new Date().toISOString();
    const expiresAt = new Date(
      Date.now() + 1000 * 60 * 60 * 24 * 30
    ).toISOString();

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
  if (!reservation?.id || !reservation?.email || !JWT_SECRET) return null;

  try {
    return jwt.sign(
      {
        reservationId: reservation.id,
        email: normalizeEmail(reservation.email),
        guestManageToken: reservation.guest_manage_token || null,
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
  if (!modReqId || !paymentIntentId || !clientSecret || !supabase)
    return false;

  const { error } = await supabase
    .from("reservation_modification_requests")
    .update({
      stripe_payment_intent_id: paymentIntentId,
      stripe_client_secret: clientSecret,
      updated_at: new Date().toISOString(),
    })
    .eq("id", modReqId);

  if (error) {
    console.error(
      "Erreur liaison PaymentIntent -> modification request :",
      error
    );
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
    console.error(
      "Erreur création reservation_modification_requests :",
      error
    );
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
    console.error(
      "Erreur annulation referral après annulation réservation :",
      e
    );
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
    const cart = readCartFromBody(body);
    const promoCode = safeText(body.promoCode, 80) || null;
    const singcoinsUsed = body.singcoinsUsed === true;
    const customer = body.customer || null;

    if (cart.length === 0) {
      return res.status(400).json({ error: "Panier vide" });
    }

    const pricing = await computeReservationCartPricing({
      cart,
      singcoinsUsed,
      promoCode,
      customer,
      referralFreeSessionApplied: false,
    });

    return res.json({
      success: true,
      pricing,
    });
  } catch (error) {
    console.error("Erreur /api/verify-cart :", error);
    return res.status(500).json({ error: error?.message || "Erreur serveur" });
  }
});

/* =========================================================
   SINGCOINS BALANCE (endpoint léger pour la page paiement)
========================================================= */

router.get("/api/singcoins/balance", authMiddleware, async (req, res) => {
  try {
    const balance = await getAvailableSingcoinsForUser(req.userId);
    return res.json({ success: true, balance });
  } catch (error) {
    console.error("Erreur /api/singcoins/balance :", error);
    return res.status(500).json({ error: "Erreur serveur" });
  }
});

/* =========================================================
   CONFIRM RESERVATION
========================================================= */

router.post(
  "/api/confirm-reservation",
  optionalAuthMiddleware,
  async (req, res) => {
    try {
      const body = req.body || {};
      const cart = readCartFromBody(body);
      const customer = body.customer || {};
      const promoCode = safeText(body.promoCode, 80) || null;
      const referralCodeRaw = safeText(body.referralCode, 80) || null;
      const singcoinsUsed = body.singcoinsUsed === true;
      const paymentIntentId = safeText(body.paymentIntentId, 200) || null;

      const authenticatedUserId = req.userId || null;

      if (
        body.userId &&
        authenticatedUserId &&
        String(body.userId) !== String(authenticatedUserId)
      ) {
        console.warn(
          "confirm-reservation: userId body ignoré car différent du token",
          {
            bodyUserId: body.userId,
            authUserId: authenticatedUserId,
          }
        );
      }

      if (cart.length === 0) {
        return res.status(400).json({ error: "Panier vide" });
      }

      const normalizedCustomerEmail = normalizeEmail(customer.email);
      if (!normalizedCustomerEmail) {
        return res.status(400).json({ error: "Email client requis" });
      }

      const fullName = buildFullName(customer);
      if (!fullName) {
        return res.status(400).json({ error: "Nom du client requis" });
      }

      if (paymentIntentId) {
        const paymentIntentAlreadyUsed =
          await isPaymentIntentAlreadyUsed(paymentIntentId);
        if (paymentIntentAlreadyUsed) {
          return res.status(409).json({
            error: "Ce paiement a déjà été utilisé pour une réservation.",
          });
        }
      }

      const resolvedUserId = await resolveReservationUserId({
        explicitUserId: authenticatedUserId,
        email: normalizedCustomerEmail,
      });

      let referralContext = { ok: true, referralCode: null, referrer: null };
      try {
        referralContext = await resolveReferralContext({
          referralCode: referralCodeRaw,
          resolvedUserId,
          normalizedCustomerEmail,
          customer,
        });

        if (!referralContext.ok) {
          return res.status(400).json({ error: referralContext.reason });
        }
      } catch (referralError) {
        console.error("Erreur resolveReferralContext :", referralError);
        referralContext = { ok: true, referralCode: null, referrer: null };
      }

      const totalPersons = sumCartPersons(cart);

      let referralRewardResult = { applied: false, reward: null };
      try {
        referralRewardResult = await consumeReferralRewardIfNeeded({
          resolvedUserId,
          totalPersons,
        });
      } catch (rewardError) {
        console.error("Erreur consumeReferralRewardIfNeeded :", rewardError);
        referralRewardResult = { applied: false, reward: null };
      }

      const pricing = await computeReservationCartPricing({
        cart,
        singcoinsUsed,
        promoCode,
        customer,
        referralFreeSessionApplied: referralRewardResult.applied,
      });

      if (!pricing?.success) {
        return res.status(400).json({
          error: pricing?.error || "Impossible de calculer le panier",
        });
      }

      for (const item of pricing.items || []) {
        const conflict = await hasReservationConflict({
          boxId: item.box_id,
          startTime: item.start_time,
          endTime: item.end_time,
          localDate: item.date,
        });

        if (conflict) {
          return res.status(409).json({
            error: "Un créneau sélectionné n'est plus disponible.",
            conflictItem: item,
          });
        }
      }

      if (singcoinsUsed) {
        if (!resolvedUserId) {
          return res.status(401).json({
            error: "Connexion requise pour utiliser les Singcoins.",
          });
        }

        const spendResult = await spendSingcoins(
          resolvedUserId,
          SINGCOINS_REWARD_COST
        );

        if (!spendResult?.success) {
          return res.status(400).json({
            error:
              spendResult?.reason || "Impossible d'utiliser les Singcoins.",
          });
        }
      }

      const reservations = await createReservationsFromCart({
        cartItems: pricing.items || [],
        customer: {
          ...customer,
          email: normalizedCustomerEmail,
        },
        userId: resolvedUserId,
        singcoinsUsed,
        paymentIntentId,
        referralFreeSessionApplied: referralRewardResult.applied,
      });

      if (!reservations) {
        if (singcoinsUsed && resolvedUserId) {
          try {
            await refundSingcoinsToUser(
              resolvedUserId,
              SINGCOINS_REWARD_COST
            );
          } catch (refundErr) {
            console.error(
              "Erreur rollback Singcoins après échec réservation :",
              refundErr
            );
          }
        }

        return res.status(500).json({ error: "Erreur création réservation" });
      }

      try {
        await handleReferralAfterReservationCreation({
          reservations,
          referralContext,
          userId: resolvedUserId,
          customerEmail: normalizedCustomerEmail,
        });
      } catch (referralAttachError) {
        console.error(
          "Erreur handleReferralAfterReservationCreation :",
          referralAttachError
        );
      }

      try {
        await markPaymentIntentReservations(
          paymentIntentId,
          reservations.map((row) => row.id)
        );
      } catch (paymentIntentLinkError) {
        console.error(
          "Erreur markPaymentIntentReservations :",
          paymentIntentLinkError
        );
      }

      try {
        await sendReservationEmailsSafe(reservations, customer);
      } catch (mailError) {
        console.error("Erreur sendReservationEmailsSafe :", mailError);
      }

      for (const reservation of reservations) {
        try {
          await safeCreateReservationGamificationEvent(reservation);
        } catch (gamiError) {
          console.error(
            "Erreur safeCreateReservationGamificationEvent :",
            gamiError
          );
        }
      }

      const firstReservation = reservations[0] || null;
      let accessToken = null;

      try {
        accessToken = await buildReservationAccessToken(firstReservation);
      } catch (tokenError) {
        console.error("Erreur buildReservationAccessToken :", tokenError);
        accessToken = null;
      }

      return res.json({
        success: true,
        reservations,
        accessToken,
        referralFreeSessionApplied: referralRewardResult.applied,
      });
    } catch (error) {
      console.error("Erreur /api/confirm-reservation :", error);
      return res.status(500).json({
        error: error?.message || "Erreur serveur",
        details:
          process.env.NODE_ENV !== "production"
            ? String(error?.stack || "")
            : undefined,
      });
    }
  }
);

router.get("/api/rebook/prepare", async (req, res) => {
  try {
    const token = safeText(req.query?.token, 2000) || "";
    const { reservation, user } = await resolveExpressRebookContext(token);

    const requestedCart = buildExpressRebookCartFromReservation(reservation);
    const requestedPricing = await computeReservationCartPricing({
      cart: requestedCart,
      customer: { email: user.email || reservation.email || "" },
      singcoinsUsed: false,
    });

    const requestedItem = requestedPricing.items?.[0] || requestedCart[0];
    const conflict = await hasReservationConflict({
      boxId: requestedItem.box_id,
      startTime: requestedItem.start_time,
      endTime: requestedItem.end_time,
      localDate: requestedItem.date,
    });

    const alternatives = conflict
      ? await listExpressRebookAlternatives(reservation, { max: 3 })
      : [];

    return res.json({
      success: true,
      available: !conflict,
      requestedSlot: {
        ...requestedItem,
        label: formatExpressSlotLabel(requestedItem),
      },
      alternatives: alternatives.map((slot) => ({
        ...slot,
        label: formatExpressSlotLabel(slot),
      })),
      customer: {
        prenom: user.prenom || "",
        nom: user.nom || "",
        email: user.email || reservation.email || "",
        telephone: user.telephone || "",
        pays: user.pays || "FR",
        adresse: user.adresse || "",
        complement: user.complement || "",
        cp: user.cp || "",
        ville: user.ville || "",
        naissance: user.naissance || null,
      },
      savedCard: {
        available: !!(user.default_payment_method_id && user.card_last4),
        paymentMethodId: user.default_payment_method_id || null,
        brand: user.card_brand || null,
        last4: user.card_last4 || null,
        exp_month: user.card_exp_month || null,
        exp_year: user.card_exp_year || null,
      },
      sourceReservation: {
        id: reservation.id,
        box_id: reservation.box_id,
        persons: reservation.persons,
        start_time: reservation.start_time,
        end_time: reservation.end_time,
      },
    });
  } catch (error) {
    console.error("Erreur /api/rebook/prepare :", error);
    return res
      .status(400)
      .json({ error: error?.message || "Lien de rebooking invalide" });
  }
});

router.post("/api/rebook/create-payment-intent", async (req, res) => {
  try {
    if (!stripe) {
      return res.status(500).json({ error: "Stripe non configuré" });
    }

    const body = req.body || {};
    const { token, requestedSlot, promoCode } = body;
    const safeToken = safeText(token, 2000) || "";
    const { reservation, user } = await resolveExpressRebookContext(safeToken);

    const persons = clampPersons(requestedSlot?.persons || 2);

    const cart = buildExpressRebookCartFromReservation(reservation, {
      ...(requestedSlot || {}),
      persons,
    });

    const pricing = await computeReservationCartPricing({
      cart,
      singcoinsUsed: false,
      promoCode: promoCode || null,
      customer: { email: user.email || reservation.email || "" },
    });

    const item = pricing.items?.[0];
    if (!item) {
      return res.status(400).json({ error: "Créneau invalide" });
    }

    const conflict = await hasReservationConflict({
      boxId: item.box_id,
      startTime: item.start_time,
      endTime: item.end_time,
      localDate: item.date,
    });

    if (conflict) {
      const alternatives = await listExpressRebookAlternatives(
        {
          ...reservation,
          persons: item.persons,
          box_id: item.box_id,
        },
        { max: 3 }
      );

      return res.status(409).json({
        error: "Le créneau demandé n’est plus disponible.",
        code: "slot_unavailable",
        alternatives: alternatives.map((slot) => ({
          ...slot,
          label: formatExpressSlotLabel(slot),
        })),
      });
    }

    if (!user.default_payment_method_id) {
      return res
        .status(400)
        .json({ error: "Aucune carte enregistrée disponible" });
    }

    const { customerId } = await ensureStripeCustomer(user.id);
    const amountInCents = Math.max(
      0,
      Math.round(
        Number(pricing.totalAfterDiscount || pricing.totalCashDue || 0) * 100
      )
    );

    if (amountInCents <= 0) {
      return res.status(400).json({
        error: "Montant invalide pour le paiement express",
      });
    }

    const paymentIntent = await stripe.paymentIntents.create({
      amount: amountInCents,
      currency: "eur",
      customer: customerId,
      payment_method: user.default_payment_method_id,
      payment_method_types: ["card"],
      metadata: {
        type: "express_rebook",
        source_reservation_id: String(reservation.id),
        rebook_start_time: String(item.start_time),
        rebook_end_time: String(item.end_time),
        rebook_box_id: String(item.box_id),
        rebook_persons: String(item.persons),
        customer_email: normalizeEmail(user.email || reservation.email || ""),
        promo_code: safeText(promoCode, 80) || "",
      },
    });

    return res.json({
      success: true,
      clientSecret: paymentIntent.client_secret,
      paymentIntentId: paymentIntent.id,
      amountEur: pricing.totalAfterDiscount || pricing.totalCashDue || 0,
      slot: { ...item, label: formatExpressSlotLabel(item) },
      savedPaymentMethodId: user.default_payment_method_id,
    });
  } catch (error) {
    console.error("Erreur /api/rebook/create-payment-intent :", error);
    return res.status(400).json({
      error: error?.message || "Impossible de préparer le paiement express",
    });
  }
});

router.post("/api/rebook/create-deposit-intent", async (req, res) => {
  try {
    if (!stripe) {
      return res.status(500).json({ error: "Stripe non configuré" });
    }

    const body = req.body || {};
    const token = safeText(body?.token, 2000) || "";
    const reservationId = safeText(body?.reservationId, 120) || null;
    const { reservation, user } = await resolveExpressRebookContext(token);

    if (!reservationId) {
      return res.status(400).json({ error: "reservationId manquant" });
    }

    if (!user.default_payment_method_id) {
      return res.status(400).json({
        error: "Aucune carte enregistrée disponible pour la caution",
      });
    }

    const { customerId } = await ensureStripeCustomer(user.id);
    const paymentIntent = await stripe.paymentIntents.create({
      amount: Math.round(Number(DEPOSIT_AMOUNT_EUR || 0) * 100),
      currency: "eur",
      customer: customerId,
      payment_method: user.default_payment_method_id,
      payment_method_types: ["card"],
      capture_method: "manual",
      metadata: {
        type: "deposit_express_rebook",
        reservation_id: reservationId,
        source_reservation_id: String(reservation.id),
        customer_email: normalizeEmail(user.email || reservation.email || ""),
      },
    });

    return res.json({
      success: true,
      clientSecret: paymentIntent.client_secret,
      paymentIntentId: paymentIntent.id,
      savedPaymentMethodId: user.default_payment_method_id,
    });
  } catch (error) {
    console.error("Erreur /api/rebook/create-deposit-intent :", error);
    return res.status(400).json({
      error: error?.message || "Impossible de préparer la caution express",
    });
  }
});

router.post("/api/rebook/confirm", async (req, res) => {
  try {
    const body = req.body || {};
    const { token, requestedSlot, paymentIntentId, promoCode } = body;
    const safeToken = safeText(token, 2000) || "";
    const { reservation, user } = await resolveExpressRebookContext(safeToken);
    const safePaymentIntentId = safeText(paymentIntentId, 200) || null;

    if (!safePaymentIntentId) {
      return res.status(400).json({ error: "paymentIntentId manquant" });
    }

    const paymentIntentAlreadyUsed = await isPaymentIntentAlreadyUsed(
      safePaymentIntentId
    );
    if (paymentIntentAlreadyUsed) {
      return res.status(409).json({
        error: "Ce paiement a déjà été utilisé pour une réservation.",
      });
    }

    const persons = clampPersons(requestedSlot?.persons || 2);

    const cart = buildExpressRebookCartFromReservation(reservation, {
      ...(requestedSlot || {}),
      persons,
    });

    const pricing = await computeReservationCartPricing({
      cart,
      singcoinsUsed: false,
      promoCode: promoCode || null,
      customer: { email: user.email || reservation.email || "" },
    });

    const item = pricing.items?.[0];
    if (!item) {
      return res.status(400).json({ error: "Créneau invalide" });
    }

    const conflict = await hasReservationConflict({
      boxId: item.box_id,
      startTime: item.start_time,
      endTime: item.end_time,
      localDate: item.date,
    });

    if (conflict) {
      const refunds = await refundExpressPaymentIntents(
        readPaymentIntentIdsFromBody(body)
      );
      const alternatives = await listExpressRebookAlternatives(
        {
          ...reservation,
          persons: item.persons,
          box_id: item.box_id,
        },
        { max: 3 }
      );

      return res.status(409).json({
        error:
          "Le créneau vient d’être pris. Le paiement a été annulé automatiquement si possible.",
        code: "slot_conflict_after_payment",
        refunded: refunds.some((entry) => entry?.result?.success),
        refundResults: refunds,
        alternatives: alternatives.map((slot) => ({
          ...slot,
          label: formatExpressSlotLabel(slot),
        })),
      });
    }

    const reservations = await createReservationsFromCart({
      cartItems: pricing.items || [],
      customer: {
        prenom: user.prenom || "",
        nom: user.nom || "",
        email: user.email || reservation.email || "",
        telephone: user.telephone || "",
        pays: user.pays || "FR",
        adresse: user.adresse || "",
        complement: user.complement || "",
        cp: user.cp || "",
        ville: user.ville || "",
        naissance: user.naissance || null,
      },
      userId: user.id,
      singcoinsUsed: false,
      paymentIntentId: safePaymentIntentId,
      referralFreeSessionApplied: false,
    });

    if (!reservations?.length) {
      const refunds = await refundExpressPaymentIntents(
        readPaymentIntentIdsFromBody(body)
      );
      return res.status(500).json({
        error: "Erreur création réservation",
        refunded: refunds.some((entry) => entry?.result?.success),
        refundResults: refunds,
      });
    }

    try {
      await markPaymentIntentReservations(
        safePaymentIntentId,
        reservations.map((row) => row.id)
      );
    } catch (paymentIntentLinkError) {
      console.error(
        "Erreur markPaymentIntentReservations express:",
        paymentIntentLinkError
      );
    }

    try {
      await sendReservationEmailsSafe(reservations, user);
    } catch (mailError) {
      console.error("Erreur sendReservationEmailsSafe express:", mailError);
    }

    let accessToken = null;
    try {
      accessToken = await buildReservationAccessToken(reservations[0] || null);
    } catch (tokenError) {
      console.error("Erreur buildReservationAccessToken express:", tokenError);
    }

    return res.json({ success: true, reservations, accessToken });
  } catch (error) {
    console.error("Erreur /api/rebook/confirm :", error);
    return res.status(400).json({
      error: error?.message || "Impossible de confirmer le rebooking express",
    });
  }
});

/* =========================================================
   AUTH RESERVATIONS
========================================================= */

router.get("/api/my-reservations", authMiddleware, async (req, res) => {
  try {
    const userId = req.userId;
    const { data, error } = await supabase
      .from("reservations")
      .select("*")
      .eq("user_id", userId)
      .order("start_time", { ascending: false });

    if (error) throw error;

    return res.json({
      success: true,
      reservations: data || [],
    });
  } catch (error) {
    console.error("Erreur /api/my-reservations :", error);
    return res.status(500).json({ error: "Erreur serveur" });
  }
});

/* =========================================================
   GUEST RESERVATION ACCESS
========================================================= */

router.get("/api/reservation-access/:token", async (req, res) => {
  try {
    const token = safeText(req.params.token, 800);
    if (!token) {
      return res.status(400).json({ error: "Token manquant" });
    }

    if (!JWT_SECRET) {
      return res.status(500).json({ error: "JWT non configuré" });
    }

    let payload = null;

    try {
      payload = jwt.verify(token, JWT_SECRET);
    } catch {
      payload = null;
    }

    if (!payload?.reservationId || !payload?.email) {
      return res.status(401).json({ error: "Token invalide" });
    }

    let reservation = null;

    if (payload.guestManageToken) {
      reservation = await getReservationByGuestToken(payload.guestManageToken);

      if (
        reservation &&
        String(reservation.id) !== String(payload.reservationId)
      ) {
        reservation = null;
      }
    }

    if (!reservation) {
      const ownedReservation = await getReservationOwnedByUser(
        payload.reservationId,
        null,
        normalizeEmail(payload.email)
      );

      if (!ownedReservation) {
        return res.status(404).json({ error: "Réservation introuvable" });
      }

      return res.json(buildGuestReservationResponse(ownedReservation));
    }

    if (normalizeEmail(reservation.email) !== normalizeEmail(payload.email)) {
      return res.status(403).json({ error: "Accès refusé" });
    }

    return res.json(buildGuestReservationResponse(reservation));
  } catch (error) {
    console.error("Erreur /api/reservation-access/:token :", error);
    return res.status(500).json({ error: "Erreur serveur" });
  }
});

router.get("/api/guest-reservation/:token", async (req, res) => {
  try {
    const token = safeText(req.params.token, 400);
    if (!token) {
      return res.status(400).json({ error: "Token manquant" });
    }

    const reservation = await getReservationByGuestToken(token);

    if (!reservation) {
      return res.status(404).json({ error: "Réservation introuvable" });
    }

    return res.json(buildGuestReservationResponse(reservation));
  } catch (error) {
    console.error("Erreur /api/guest-reservation/:token :", error);
    return res.status(500).json({ error: "Erreur serveur" });
  }
});

/* =========================================================
   UPDATE PROFILE AFTER GUEST RESERVATION
========================================================= */

router.post("/api/reservation-profile", authMiddleware, async (req, res) => {
  try {
    const userId = req.userId;
    const body = req.body || {};

    await updateUserProfileInUsersTable(userId, body);

    return res.json({ success: true });
  } catch (error) {
    console.error("Erreur /api/reservation-profile :", error);
    return res.status(500).json({ error: "Erreur serveur" });
  }
});

/* =========================================================
   MODIFICATION
========================================================= */

async function runReservationModification({
  reservation,
  newStartTime,
  newEndTime,
  newPersons,
  boxId = null,
  userId = null,
  customer = null,
  isGuest = false,
}) {
  if (!reservation) {
    return {
      ok: false,
      status: 404,
      body: { error: "Réservation introuvable" },
    };
  }

  if (!isReservationStatusModifiable(reservation.status)) {
    return {
      ok: false,
      status: 400,
      body: { error: "Cette réservation ne peut pas être modifiée" },
    };
  }

  if (!isWithinModificationWindow(reservation.start_time)) {
    return {
      ok: false,
      status: 400,
      body: {
        error: `La modification n'est plus possible (moins de ${MODIFICATION_DEADLINE_HOURS}h avant la séance).`,
      },
    };
  }

  const previousStartTime = reservation.start_time;
  const previousEndTime = reservation.end_time;
  const previousBoxId = Number(reservation.box_id || 1);
  const previousPersons = Number(reservation.persons || 2);

  const safePersons = clampPersons(
    newPersons || getReservationPersons(reservation)
  );

  const currentStart = parseDateOrNull(reservation.start_time);
  const targetStart = parseDateOrNull(newStartTime || reservation.start_time);
  const targetEnd =
    parseDateOrNull(newEndTime) ||
    (targetStart
      ? new Date(targetStart.getTime() + SLOT_DURATION_MINUTES * 60 * 1000)
      : null);

  if (!currentStart || !targetStart || !targetEnd) {
    return {
      ok: false,
      status: 400,
      body: { error: "Nouveau créneau invalide" },
    };
  }

  if (!isWithinModificationWindow(targetStart.toISOString())) {
    return {
      ok: false,
      status: 400,
      body: {
        error: `Le nouveau créneau doit aussi être à plus de ${MODIFICATION_DEADLINE_HOURS}h de l'heure actuelle`,
      },
    };
  }

  const targetBoxId = Number(boxId || reservation.box_id || 1);
  const targetLocalDate = formatDateToYYYYMMDD(targetStart);

  const conflict = await hasReservationConflict({
    boxId: targetBoxId,
    startTime: targetStart.toISOString(),
    endTime: targetEnd.toISOString(),
    localDate: targetLocalDate,
    excludeReservationId: reservation.id,
  });

  if (conflict) {
    return {
      ok: false,
      status: 409,
      body: { error: "Le nouveau créneau n’est plus disponible" },
    };
  }

  const singcoinsRewardUsed = isReservationPaidWithSingcoins(reservation);

  if (isGuest && singcoinsRewardUsed) {
    return {
      ok: false,
      status: 409,
      body: {
        error:
          "Cette réservation liée aux Singcoins doit être modifiée depuis un compte connecté.",
      },
    };
  }

  const { oldAmount, newAmount, deltaAmount } = computeModificationDelta({
    reservation,
    targetStart,
    targetPersons: safePersons,
  });

  if (isPassReservation(reservation) && deltaAmount < 0) {
    return {
      ok: false,
      status: 409,
      body: {
        error:
          "Les réservations payées avec un pass Singbox ne peuvent pas générer de remboursement.",
        code: "PASS_RESERVATION_NO_REFUND",
        financial: {
          oldAmount,
          newAmount,
          deltaAmount,
        },
      },
    };
  }

  let autoChargeDone = false;
  let refundDone = false;
  let newPaymentIntentId = null;

  if (deltaAmount > 0) {
    if (isGuest || !userId) {
      if (!stripe || !supabase) {
        return {
          ok: false,
          status: 500,
          body: { error: "Paiement indisponible" },
        };
      }

      const modReq = await createPendingModificationRequest({
        reservation,
        oldAmount,
        newAmount,
        deltaAmount,
        targetStart,
        targetEnd,
        safePersons,
        targetBoxId,
      });

      if (!modReq) {
        return {
          ok: false,
          status: 500,
          body: { error: "Erreur création modification" },
        };
      }

      const paymentIntent = await stripe.paymentIntents.create({
        amount: Math.round(deltaAmount * 100),
        currency: "eur",
        metadata: {
          type: "modification",
          modification_request_id: String(modReq.id),
        },
      });

      await supabase
        .from("reservation_modification_requests")
        .update({
          stripe_payment_intent_id: paymentIntent.id,
          stripe_client_secret: paymentIntent.client_secret,
        })
        .eq("id", modReq.id);

      return {
        ok: false,
        status: 200,
        body: {
          requiresPayment: true,
          clientSecret: paymentIntent.client_secret,
          amount: deltaAmount,
        },
      };
    }

    const autoCharge = await attemptAutomaticSavedCardCharge({
      userId,
      customer: customer || { email: reservation.email, prenom: "", nom: "" },
      amountEur: deltaAmount,
      metadata: {
        reservation_id: String(reservation.id),
        modification_delta_amount: String(deltaAmount),
        modification_type: "increase",
      },
    });

    if (!autoCharge.success) {
      if (autoCharge.clientSecret && autoCharge.paymentIntentId) {
        const modReq = await createPendingModificationRequest({
          reservation,
          oldAmount,
          newAmount,
          deltaAmount,
          targetStart,
          targetEnd,
          safePersons,
          targetBoxId,
          stripePaymentIntentId: autoCharge.paymentIntentId,
          stripeClientSecret: autoCharge.clientSecret,
        });

        if (!modReq) {
          return {
            ok: false,
            status: 500,
            body: { error: "Erreur création modification" },
          };
        }

        const linked = await attachPaymentIntentToModificationRequest({
          modReqId: modReq.id,
          paymentIntentId: autoCharge.paymentIntentId,
          clientSecret: autoCharge.clientSecret,
        });

        if (!linked) {
          return {
            ok: false,
            status: 500,
            body: {
              error:
                "Impossible de préparer le paiement de la modification.",
            },
          };
        }

        return {
          ok: false,
          status: 200,
          body: {
            requiresPayment: true,
            clientSecret: autoCharge.clientSecret,
            amount: deltaAmount,
          },
        };
      }

      return {
        ok: false,
        status: 409,
        body: {
          success: false,
          requiresAdditionalPayment: true,
          error:
            autoCharge.reason ||
            "Le débit automatique a échoué. Une authentification ou une nouvelle carte est requise.",
          clientSecret: autoCharge.clientSecret || null,
          paymentIntentId: autoCharge.paymentIntentId || null,
          financial: {
            oldAmount,
            newAmount,
            deltaAmount,
            singcoinsRewardUsed,
          },
        },
      };
    }

    autoChargeDone = true;
    newPaymentIntentId = autoCharge.paymentIntent?.id || null;
  }

  if (deltaAmount < 0) {
    const refundAmount = Math.abs(deltaAmount);

    const refundResult = await attemptAutomaticRefundAcrossPaymentIntents(
      reservation,
      refundAmount
    );

    if (!refundResult.success) {
      return {
        ok: false,
        status: 500,
        body: {
          error:
            refundResult.reason ||
            "Impossible d’effectuer automatiquement le remboursement Stripe.",
          financial: {
            oldAmount,
            newAmount,
            deltaAmount,
            singcoinsRewardUsed,
          },
        },
      };
    }

    refundDone = true;
  }

  const updatedReservation = await updateReservationById(reservation.id, {
    start_time: targetStart.toISOString(),
    end_time: targetEnd.toISOString(),
    date: targetLocalDate,
    datetime: targetStart.toISOString(),
    box_id: targetBoxId,
    persons: safePersons,
    billable_persons: Math.max(safePersons, 2),
    montant: newAmount,
    free_session: isPassReservation(reservation) ? true : newAmount <= 0,
    singcoins_used: singcoinsRewardUsed,
    singcoins_spent: singcoinsRewardUsed ? SINGCOINS_REWARD_COST : 0,
    latest_payment_intent_id:
      newPaymentIntentId ||
      reservation.latest_payment_intent_id ||
      reservation.payment_intent_id ||
      reservation.original_payment_intent_id ||
      null,
    original_payment_intent_id:
      reservation.original_payment_intent_id ||
      reservation.payment_intent_id ||
      null,
    refunded_amount: roundMoney(
      Number(reservation.refunded_amount || 0) +
        (deltaAmount < 0 ? Math.abs(deltaAmount) : 0)
    ),
    last_auto_charge_amount: deltaAmount > 0 ? deltaAmount : 0,
    is_weekend: targetStart.getDay() === 0 || targetStart.getDay() === 6,
    is_daytime: targetStart.getHours() >= 12 && targetStart.getHours() < 18,
    is_group_session: safePersons >= 3,
    session_minutes: Math.floor((targetEnd - targetStart) / 60000),
    updated_at: new Date().toISOString(),
  });

  const scheduleChanged =
    previousStartTime !== updatedReservation.start_time ||
    previousEndTime !== updatedReservation.end_time ||
    previousBoxId !== Number(updatedReservation.box_id || 1);

  const personsChanged =
    previousPersons !== Number(updatedReservation.persons || 2);

  if (updatedReservation?.email && (scheduleChanged || personsChanged)) {
    try {
      await sendReservationModificationEmail(updatedReservation, {
        scheduleChanged,
        personsChanged,
        previousStartTime,
        previousEndTime,
      });
    } catch (mailErr) {
      console.error(
        "Erreur envoi email confirmation modification réservation :",
        mailErr
      );
    }
  }

  return {
    ok: true,
    status: 200,
    body: {
      success: true,
      message:
        deltaAmount > 0
          ? "Réservation modifiée avec débit automatique du supplément."
          : deltaAmount < 0
            ? "Réservation modifiée avec remboursement automatique."
            : "Réservation modifiée sans supplément ni remboursement.",
      reservation: updatedReservation,
      financial: {
        oldAmount,
        newAmount,
        deltaAmount,
        singcoinsRewardUsed,
        autoChargeDone,
        refundDone,
      },
    },
  };
}

async function runReservationRefund({
  reservation,
  userId = null,
  isGuest = false,
}) {
  if (!reservation) {
    return {
      ok: false,
      status: 404,
      body: { error: "Réservation introuvable" },
    };
  }

  const start = parseDateOrNull(reservation.start_time);
  if (!start) {
    return {
      ok: false,
      status: 400,
      body: { error: "Date de réservation invalide" },
    };
  }

  if (isPassReservation(reservation)) {
    return {
      ok: false,
      status: 409,
      body: {
        error:
          "Les réservations payées avec un pass Singbox ne sont pas remboursables.",
        code: "PASS_RESERVATION_NOT_REFUNDABLE",
      },
    };
  }

  if (!isWithinRefundWindow(reservation.start_time)) {
    return {
      ok: false,
      status: 400,
      body: {
        error: `Le remboursement n'est plus possible (moins de ${REFUND_DEADLINE_HOURS}h avant la séance).`,
      },
    };
  }

  const singcoinsRewardUsed = isReservationPaidWithSingcoins(reservation);
  const singcoinsToRefund = singcoinsRewardUsed
    ? Number(getReservationSingcoinsUsed(reservation))
    : 0;
  const cashAmountToRefund = Number(reservation.montant || 0);

  if (isGuest && singcoinsToRefund > 0) {
    return {
      ok: false,
      status: 409,
      body: {
        error:
          "Cette réservation liée aux Singcoins doit être remboursée depuis un compte connecté.",
      },
    };
  }

  let stripeRefundDone = false;
  let singcoinsRefundDone = false;

  if (cashAmountToRefund > 0) {
    const refundResult = await attemptAutomaticRefundAcrossPaymentIntents(
      reservation,
      cashAmountToRefund
    );

    if (!refundResult.success) {
      return {
        ok: false,
        status: 500,
        body: {
          error:
            refundResult.reason ||
            "Impossible d’effectuer automatiquement le remboursement Stripe.",
        },
      };
    }

    stripeRefundDone = true;
  }

  if (singcoinsToRefund > 0) {
    if (!userId) {
      return {
        ok: false,
        status: 400,
        body: {
          error: "Utilisateur requis pour rembourser les Singcoins.",
        },
      };
    }

    const singcoinsRefund = await refundSingcoinsToUser(
      userId,
      singcoinsToRefund
    );

    if (!singcoinsRefund?.success) {
      return {
        ok: false,
        status: 500,
        body: {
          error: "Impossible de rembourser les Singcoins.",
        },
      };
    }

    singcoinsRefundDone = true;
  }

  const updatedReservation = await updateReservationById(reservation.id, {
    status: "refunded",
    refunded_at: new Date().toISOString(),
    refunded_amount: roundMoney(
      Number(reservation.refunded_amount || 0) + cashAmountToRefund
    ),
    updated_at: new Date().toISOString(),
  });

  await invalidateGuestManageToken(reservation.id);
  await maybeCancelReferralAfterCancellation(reservation.id);

  return {
    ok: true,
    status: 200,
    body: {
      success: true,
      reservation: updatedReservation,
      financial: {
        cashAmountToRefund,
        singcoinsToRefund,
        stripeRefundDone,
        singcoinsRefundDone,
      },
    },
  };
}

router.post("/api/modify-reservation", authMiddleware, async (req, res) => {
  try {
    const body = req.body || {};
    const reservationId = body.reservationId;
    const newStartTime = body.newStartTime;
    const newEndTime = body.newEndTime;
    const newPersons = body.newPersons;
    const boxId = body.boxId || null;
    const userId = req.userId;

    const reservation = await getReservationOwnedByUser(
      reservationId,
      userId,
      null
    );

    if (!reservation) {
      return res.status(404).json({ error: "Réservation introuvable" });
    }

    const result = await runReservationModification({
      reservation,
      newStartTime,
      newEndTime,
      newPersons,
      boxId,
      userId,
      customer: {
        email: reservation.email,
        prenom: "",
        nom: "",
      },
      isGuest: false,
    });

    return res.status(result.status).json(result.body);
  } catch (error) {
    console.error("Erreur /api/modify-reservation :", error);
    return res.status(500).json({ error: "Erreur serveur" });
  }
});

router.post("/api/guest-modify-reservation", async (req, res) => {
  try {
    const body = req.body || {};
    const token = safeText(body.token, 400);
    const newStartTime = body.newStartTime;
    const newEndTime = body.newEndTime;
    const newPersons = body.newPersons;
    const boxId = body.boxId || null;

    if (!token) {
      return res.status(400).json({ error: "Token manquant" });
    }

    const reservation = await getReservationByGuestToken(token);

    if (!reservation) {
      return res.status(404).json({ error: "Réservation introuvable" });
    }

    const result = await runReservationModification({
      reservation,
      newStartTime,
      newEndTime,
      newPersons,
      boxId,
      userId: null,
      customer: {
        email: reservation.email,
        prenom: "",
        nom: "",
      },
      isGuest: true,
    });

    return res.status(result.status).json(result.body);
  } catch (error) {
    console.error("Erreur /api/guest-modify-reservation :", error);
    return res.status(500).json({ error: "Erreur serveur" });
  }
});

/* =========================================================
   REFUND
========================================================= */

router.post("/api/refund-reservation", authMiddleware, async (req, res) => {
  try {
    const reservationId = req.body?.reservationId;
    const userId = req.userId;

    const reservation = await getReservationOwnedByUser(
      reservationId,
      userId,
      null
    );

    if (!reservation) {
      return res.status(404).json({ error: "Réservation introuvable" });
    }

    const result = await runReservationRefund({
      reservation,
      userId,
      isGuest: false,
    });

    return res.status(result.status).json(result.body);
  } catch (error) {
    console.error("Erreur /api/refund-reservation :", error);
    return res.status(500).json({ error: "Erreur serveur" });
  }
});

router.post("/api/guest-refund-reservation", async (req, res) => {
  try {
    const token = safeText(req.body?.token, 400);

    if (!token) {
      return res.status(400).json({ error: "Token manquant" });
    }

    const reservation = await getReservationByGuestToken(token);

    if (!reservation) {
      return res.status(404).json({ error: "Réservation introuvable" });
    }

    const result = await runReservationRefund({
      reservation,
      userId: null,
      isGuest: true,
    });

    return res.status(result.status).json(result.body);
  } catch (error) {
    console.error("Erreur /api/guest-refund-reservation :", error);
    return res.status(500).json({ error: "Erreur serveur" });
  }
});

/* =========================================================
   COMPLETE RESERVATION
========================================================= */

router.post(
  "/api/complete-reservation",
  requireAdminOrCron,
  async (req, res) => {
    try {
      const reservationId = safeText(req.body?.reservationId, 120);

      if (!reservationId) {
        return res.status(400).json({ error: "reservationId manquant" });
      }

      if (!supabase) {
        return res.status(500).json({ error: "Supabase non configuré" });
      }

      const { data: reservation, error } = await supabase
        .from("reservations")
        .select("*")
        .eq("id", reservationId)
        .maybeSingle();

      if (error) throw error;

      if (!reservation) {
        return res.status(404).json({ error: "Réservation introuvable" });
      }

      const currentStatus = normalizeReservationStatus(reservation.status);

      if (isCompletedStatus(currentStatus)) {
        let gamification = null;

        if (reservation.user_id) {
          try {
            gamification = await getUserGamificationSnapshot(
              reservation.user_id
            );
          } catch (gErr) {
            console.error(
              "Erreur snapshot gamification sur réservation déjà complétée :",
              gErr
            );
          }
        }

        return res.json({
          success: true,
          alreadyCompleted: true,
          reservation,
          gamification,
          completedBy: req.isCron ? "cron" : "admin",
        });
      }

      if (isCancelledOrRefundedStatus(currentStatus)) {
        return res.status(409).json({
          error:
            "Impossible de terminer une réservation annulée ou remboursée.",
        });
      }

      const updated = await updateReservationById(reservation.id, {
        status: "completed",
        completed_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      });

      try {
        const existingReview =
          await getExistingReviewRequestByReservationId(reservation.id);
        if (
          !existingReview ||
          (existingReview.status !== "used" &&
            existingReview.status !== "pending")
        ) {
          await sendReviewRequestEmail(updated || reservation);
        }
      } catch (reviewMailErr) {
        console.error(
          "Erreur envoi mail d'avis après completion :",
          reviewMailErr
        );
      }

      if (updated?.user_id) {
        try {
          await maybeValidateReferralAfterCompletion(updated);

          const snapshot =
            (await processReservationGamification(updated.id)) ||
            (await getUserGamificationSnapshot(updated.user_id));

          return res.json({
            success: true,
            reservation: updated,
            gamification: snapshot,
            completedBy: req.isCron ? "cron" : "admin",
          });
        } catch (gErr) {
          console.error("Erreur gamification après completion :", gErr);

          return res.json({
            success: true,
            reservation: updated,
            completedBy: req.isCron ? "cron" : "admin",
          });
        }
      }

      return res.json({
        success: true,
        reservation: updated,
        completedBy: req.isCron ? "cron" : "admin",
      });
    } catch (error) {
      console.error("Erreur /api/complete-reservation :", error);
      return res.status(500).json({ error: "Erreur serveur" });
    }
  }
);

/* =========================================================
   REFERRAL HELPERS
========================================================= */

router.get("/api/referral/me", authMiddleware, async (req, res) => {
  try {
    const userId = req.userId;

    const code = await ensureUserReferralCode(userId);
    const summary = await getUserReferralSummary(userId);

    return res.json({
      success: true,
      referralCode: code,
      summary,
    });
  } catch (error) {
    console.error("Erreur /api/referral/me :", error);
    return res.status(500).json({ error: "Erreur serveur" });
  }
});

/* =========================================================
   SLOT HELPERS
========================================================= */

router.get("/api/standard-slot-starts", async (_req, res) => {
  return res.json({
    success: true,
    slots: STANDARD_SLOT_STARTS,
  });
});

router.post("/api/build-slot-range", async (req, res) => {
  try {
    const date = safeText(req.body?.date, 20);
    const slot = safeText(req.body?.slot, 20);

    if (!date || !slot) {
      return res.status(400).json({ error: "date et slot requis" });
    }

    const slotValue = Number(slot);
    if (!Number.isFinite(slotValue)) {
      return res.status(400).json({ error: "slot invalide" });
    }

    const range = buildSlotIsoRange(date, slotValue);
    return res.json({
      success: true,
      ...range,
    });
  } catch (error) {
    console.error("Erreur /api/build-slot-range :", error);
    return res.status(500).json({ error: "Erreur serveur" });
  }
});

router.post("/api/build-times-from-slot", async (req, res) => {
  try {
    const date = safeText(req.body?.date, 20);
    const slot = safeText(req.body?.slot, 20);

    if (!date || !slot) {
      return res.status(400).json({ error: "date et slot requis" });
    }

    const slotValue = Number(slot);
    if (!Number.isFinite(slotValue)) {
      return res.status(400).json({ error: "slot invalide" });
    }

    const times = buildTimesFromSlot({
      date,
      hour: slotValue,
    });

    return res.json({
      success: true,
      ...times,
    });
  } catch (error) {
    console.error("Erreur /api/build-times-from-slot :", error);
    return res.status(500).json({ error: "Erreur serveur" });
  }
});

/* =========================================================
   CART CASH AMOUNT
========================================================= */

router.post("/api/session-cash-amount", async (req, res) => {
  try {
    const startTime = req.body?.startTime;
    const persons = clampPersons(req.body?.persons);
    const singcoinsUsed = req.body?.singcoinsUsed === true;

    if (!startTime) {
      return res.status(400).json({ error: "startTime requis" });
    }

    const startDate = parseDateOrNull(startTime);
    if (!startDate) {
      return res.status(400).json({ error: "startTime invalide" });
    }

    const amount = computeSessionCashAmount(startDate, persons, {
      singcoinsUsed,
    });

    return res.json({
      success: true,
      amount,
    });
  } catch (error) {
    console.error("Erreur /api/session-cash-amount :", error);
    return res.status(500).json({ error: "Erreur serveur" });
  }
});

/* =========================================================
   GAMIFICATION DEBUG
========================================================= */

router.post(
  "/api/debug-credit-singcoins",
  requireSupabaseAdmin,
  async (req, res) => {
    try {
      const targetUserId = safeText(req.body?.userId, 120) || req.userId;
      const amount = Number(req.body?.amount || 0);
      const label =
        safeText(req.body?.label, 120) || "Crédit debug Singcoins";

      if (!targetUserId) {
        return res.status(400).json({ error: "userId manquant" });
      }

      if (!Number.isFinite(amount) || amount <= 0) {
        return res.status(400).json({ error: "Montant invalide" });
      }

      const result = await creditSingcoins({
        userId: targetUserId,
        amount,
        type: "manual_debug",
        referenceType: "debug",
        referenceId: `debug-${Date.now()}`,
        label,
      });

      return res.json({
        success: true,
        result,
      });
    } catch (error) {
      console.error("Erreur /api/debug-credit-singcoins :", error);
      return res.status(500).json({ error: "Erreur serveur" });
    }
  }
);

/* =========================================================
   USER GAMIFICATION SNAPSHOT
========================================================= */

router.get("/api/gamification/me", authMiddleware, async (req, res) => {
  try {
    const snapshot = await getUserGamificationSnapshot(req.userId);

    return res.json({
      success: true,
      snapshot,
    });
  } catch (error) {
    console.error("Erreur /api/gamification/me :", error);
    return res.status(500).json({ error: "Erreur serveur" });
  }
});

export default router;
