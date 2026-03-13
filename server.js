// backend/server.js

import express from "express";
import cors from "cors";
import bodyParser from "body-parser";
import Stripe from "stripe";
import { createClient } from "@supabase/supabase-js";
import dotenv from "dotenv";
import { Resend } from "resend";
import QRCode from "qrcode";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";

dotenv.config();

// ---------- CONFIG ENV ----------
const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY;
const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET;

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const RESEND_API_KEY = process.env.RESEND_API_KEY;

if (!STRIPE_SECRET_KEY) {
  console.error("❌ STRIPE_SECRET_KEY manquante dans .env");
}
if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.warn(
    "⚠️ SUPABASE_URL ou SUPABASE_SERVICE_ROLE_KEY manquantes dans .env (réservations non actives)"
  );
}
if (!RESEND_API_KEY) {
  console.warn("⚠️ RESEND_API_KEY manquante : l'envoi d'email sera désactivé");
}
if (!STRIPE_WEBHOOK_SECRET) {
  console.warn("⚠️ STRIPE_WEBHOOK_SECRET manquant : les webhooks Stripe ne seront pas vérifiés");
}
if (!process.env.JWT_SECRET) {
  console.warn("⚠️ JWT_SECRET manquant : l'auth (login/register) va échouer");
}

// ---------- INIT CLIENTS ----------
const stripe = STRIPE_SECRET_KEY
  ? new Stripe(STRIPE_SECRET_KEY, {
      apiVersion: "2023-10-16",
    })
  : null;

const supabase =
  SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY
    ? createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)
    : null;

const mailEnabled = !!RESEND_API_KEY;
const resend = mailEnabled ? new Resend(RESEND_API_KEY) : null;

const app = express();

app.use(
  cors({
    origin: "*",
  })
);

console.log("🌍 CORS autorise l'origine : *");

// ---------- CONSTANTES ----------
const PRICE_PER_SLOT_EUR = 10;
const DEPOSIT_AMOUNT_EUR = 250;
const SLOT_DURATION_MINUTES = 90;
const MODIFICATION_DEADLINE_HOURS = 6;

const STANDARD_SLOT_STARTS = [4, 5.5, 7, 8.5, 10, 11.5, 13, 14.5, 16, 17.5, 19, 20.5, 22];

const MIN_ALLOWED_PERSONS = 1;
const MAX_ALLOWED_PERSONS = 8;
const MIN_BILLABLE_PERSONS = 2;

const LOYALTY_POINTS_COST = 100;
const LOYALTY_FREE_BILLABLE_PERSONS = 2;

const OFF_PEAK_START_HOUR = 4;
const OFF_PEAK_END_HOUR = 14;
const OFF_PEAK_RATE = 7.9;
const STANDARD_RATE = 9.9;

// ------------------------------------------------------
// Vacances scolaires (Zone C : Toulouse)
// ------------------------------------------------------
const VACANCES_ZONE_C = [
  { start: "2025-10-19", end: "2025-11-03", label: "Toussaint 2025" },
  { start: "2025-12-21", end: "2026-01-05", label: "Noël 2025" },
  { start: "2026-02-22", end: "2026-03-09", label: "Hiver 2026" },
  { start: "2026-04-19", end: "2026-05-04", label: "Printemps 2026" },
  { start: "2026-07-05", end: "2026-09-01", label: "Été 2026" },
];

function isDateInRange(isoDate, start, end) {
  return isoDate >= start && isoDate <= end;
}

// ------------------------------------------------------
// Helpers généraux
// ------------------------------------------------------
function safeText(v, max = 255) {
  if (v === undefined || v === null) return null;
  const s = String(v).trim();
  if (!s) return null;
  return s.length > max ? s.slice(0, max) : s;
}

function safeCountry(v) {
  const s = String(v || "").trim();
  if (!s) return null;
  return s.length > 10 ? s.slice(0, 10) : s;
}

function safeBirthdate(v) {
  if (!v) return null;
  const s = String(v).slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  return s;
}

function parseDateOrNull(value) {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

function formatDateToYYYYMMDD(dateObj) {
  const y = dateObj.getFullYear();
  const m = String(dateObj.getMonth() + 1).padStart(2, "0");
  const d = String(dateObj.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function addDaysToDateString(dateStr, daysToAdd) {
  const [y, m, d] = dateStr.split("-").map((x) => parseInt(x, 10));
  const base = new Date(Date.UTC(y, m - 1, d));
  base.setUTCDate(base.getUTCDate() + daysToAdd);
  const ny = base.getUTCFullYear();
  const nm = String(base.getUTCMonth() + 1).padStart(2, "0");
  const nd = String(base.getUTCDate()).padStart(2, "0");
  return `${ny}-${nm}-${nd}`;
}

function getNumericBoxId(rawBox) {
  let numericBoxId = parseInt(String(rawBox).replace(/[^0-9]/g, ""), 10);
  if (!Number.isFinite(numericBoxId)) numericBoxId = 1;
  return numericBoxId;
}

function clampPersons(value) {
  let n = Number.parseInt(value, 10);
  if (Number.isNaN(n) || n < MIN_ALLOWED_PERSONS) n = MIN_ALLOWED_PERSONS;
  if (n > MAX_ALLOWED_PERSONS) n = MAX_ALLOWED_PERSONS;
  return n;
}

function getBillablePersons(persons) {
  const n = Number(persons);
  if (!Number.isFinite(n)) return MIN_BILLABLE_PERSONS;
  return Math.max(n, MIN_BILLABLE_PERSONS);
}

function isWeekend(dateObj) {
  const day = dateObj.getDay();
  return day === 0 || day === 6;
}

function isHolidayLike(dateObj) {
  const iso = formatDateToYYYYMMDD(dateObj);
  return VACANCES_ZONE_C.some((p) => isDateInRange(iso, p.start, p.end));
}

function getPerPersonRateForDate(dateObj) {
  const hour = dateObj.getHours();

  if (isWeekend(dateObj) || isHolidayLike(dateObj)) {
    return STANDARD_RATE;
  }

  if (hour >= OFF_PEAK_START_HOUR && hour < OFF_PEAK_END_HOUR) {
    return OFF_PEAK_RATE;
  }

  return STANDARD_RATE;
}

function hoursBeforeDate(isoValue) {
  const d = parseDateOrNull(isoValue);
  if (!d) return null;
  return (d.getTime() - Date.now()) / (1000 * 60 * 60);
}

function isReservationStatusModifiable(statusRaw) {
  const s = String(statusRaw || "").toLowerCase();
  return s.includes("confirme") || s === "confirmed";
}

function isWithinModificationWindow(startTimeIso) {
  const diff = hoursBeforeDate(startTimeIso);
  if (diff === null) return false;
  return diff >= MODIFICATION_DEADLINE_HOURS;
}

function buildTimesFromSlot(slot) {
  if (slot.start_time && slot.end_time) {
    const dateFromStart = slot.date || String(slot.start_time).slice(0, 10);
    return {
      start_time: slot.start_time,
      end_time: slot.end_time,
      date: dateFromStart,
      datetime: slot.start_time,
    };
  }

  const date = slot.date;
  const rawHour = slot.hour;

  if (!date || rawHour === undefined || rawHour === null) {
    throw new Error("Slot incomplet : date / hour ou start_time / end_time manquants");
  }

  let hourNum = 0;
  let minuteNum = 0;

  if (typeof rawHour === "number") {
    hourNum = Math.floor(rawHour);
    minuteNum = Math.round((rawHour - hourNum) * 60);
  } else {
    const m = String(rawHour).match(/(\d{1,2})[h:]?(\d{2})?/);
    if (m) {
      hourNum = parseInt(m[1], 10);
      minuteNum = m[2] ? parseInt(m[2], 10) : 0;
    }
  }

  const OFFSET = "+01:00";

  const startHourStr = String(hourNum).padStart(2, "0");
  const startMinStr = String(minuteNum).padStart(2, "0");
  const startIso = `${date}T${startHourStr}:${startMinStr}:00${OFFSET}`;

  const totalStartMinutes = hourNum * 60 + minuteNum + SLOT_DURATION_MINUTES;
  const minutesPerDay = 24 * 60;

  const endDayOffset = Math.floor(totalStartMinutes / minutesPerDay);
  const minutesOfDay = totalStartMinutes % minutesPerDay;

  const endHour = Math.floor(minutesOfDay / 60);
  const endMinute = minutesOfDay % 60;

  const endDateStr =
    endDayOffset === 0 ? date : addDaysToDateString(date, endDayOffset);

  const endHourStr = String(endHour).padStart(2, "0");
  const endMinStr = String(endMinute).padStart(2, "0");
  const endIso = `${endDateStr}T${endHourStr}:${endMinStr}:00${OFFSET}`;

  return {
    start_time: startIso,
    end_time: endIso,
    date,
    datetime: startIso,
  };
}

function buildSlotIsoRange(dateStr, slotHourFloat) {
  const hourNum = Math.floor(slotHourFloat);
  const minuteNum = Math.round((slotHourFloat - hourNum) * 60);

  const OFFSET = "+01:00";
  const hh = String(hourNum).padStart(2, "0");
  const mm = String(minuteNum).padStart(2, "0");

  const startIso = `${dateStr}T${hh}:${mm}:00${OFFSET}`;
  const startDate = new Date(startIso);
  const endDate = new Date(startDate.getTime() + SLOT_DURATION_MINUTES * 60 * 1000);

  const endY = endDate.getFullYear();
  const endM = String(endDate.getMonth() + 1).padStart(2, "0");
  const endD = String(endDate.getDate()).padStart(2, "0");
  const endH = String(endDate.getHours()).padStart(2, "0");
  const endMin = String(endDate.getMinutes()).padStart(2, "0");

  const endIso = `${endY}-${endM}-${endD}T${endH}:${endMin}:00${OFFSET}`;

  return { startIso, endIso };
}

// ------------------------------------------------------
// Helpers fidélité / pricing
// ------------------------------------------------------
function isReservationPaidWithLoyalty(reservation) {
  const explicitFlags = [
    reservation?.paid_with_loyalty,
    reservation?.used_loyalty_reward,
    reservation?.loyalty_reward_used,
    reservation?.used_points,
    reservation?.offered_by_loyalty,
  ];

  if (explicitFlags.some(Boolean)) return true;

  const paymentMode = String(
    reservation?.payment_mode ||
      reservation?.paymentMode ||
      reservation?.payment_type ||
      ""
  ).toLowerCase();

  return (
    paymentMode.includes("fidel") ||
    paymentMode.includes("loyalty") ||
    paymentMode.includes("reward") ||
    paymentMode.includes("points")
  );
}

function getReservationLoyaltyPointsUsed(reservation) {
  const candidates = [
    reservation?.loyalty_points_used,
    reservation?.points_used,
    reservation?.used_points_count,
  ];

  for (const candidate of candidates) {
    const n = Number(candidate);
    if (Number.isFinite(n) && n > 0) return n;
  }

  return isReservationPaidWithLoyalty(reservation) ? LOYALTY_POINTS_COST : 0;
}

function isReservationFreeLike(reservation) {
  if (isReservationPaidWithLoyalty(reservation)) {
    const amount = getReservationAmountPaid(reservation);
    return amount <= 0;
  }

  const explicitFlags = [
    reservation?.free_session,
    reservation?.is_free_session,
  ];

  if (explicitFlags.some(Boolean)) return true;

  const paymentMode = String(
    reservation?.payment_mode ||
      reservation?.paymentMode ||
      reservation?.payment_type ||
      ""
  ).toLowerCase();

  if (
    paymentMode.includes("gratuit") ||
    paymentMode.includes("free") ||
    paymentMode.includes("offert")
  ) {
    return true;
  }

  return getReservationAmountPaid(reservation) <= 0;
}

function getReservationPersons(reservation) {
  const candidates = [
    reservation?.persons,
    reservation?.nb_personnes,
    reservation?.participants,
    reservation?.people_count,
  ];

  for (const candidate of candidates) {
    const n = Number(candidate);
    if (Number.isFinite(n) && n >= 1 && n <= 8) {
      return n;
    }
  }

  return 2;
}

function getReservationAmountPaid(reservation) {
  const candidates = [
    reservation?.amount_paid,
    reservation?.montant,
    reservation?.total,
    reservation?.total_price,
    reservation?.amountPaid,
    reservation?.paid_amount,
  ];

  for (const candidate of candidates) {
    const n = Number(candidate);
    if (Number.isFinite(n)) {
      return n;
    }
  }

  return 0;
}

function computeSessionCashAmount(startDate, persons, options = {}) {
  const billablePersons = getBillablePersons(persons);
  const perPersonRate = getPerPersonRateForDate(startDate);
  const loyaltyUsed = !!options.loyaltyUsed;

  if (!loyaltyUsed) {
    return Number((billablePersons * perPersonRate).toFixed(2));
  }

  const extraBillablePersons = Math.max(
    0,
    billablePersons - LOYALTY_FREE_BILLABLE_PERSONS
  );

  return Number((extraBillablePersons * perPersonRate).toFixed(2));
}

function computeCartPricing(panier, options = {}) {
  const loyaltyUsed = !!options.loyaltyUsed;

  const normalizedItems = panier.map((slot) => {
    const times = buildTimesFromSlot(slot);
    const startDate = new Date(times.start_time);
    const rawBox = slot.boxId ?? slot.box_id ?? slot.box ?? slot.boxName ?? 1;
    const numericBoxId = getNumericBoxId(rawBox);
    const persons = clampPersons(slot.persons || slot.nb_personnes || slot.participants || 2);

    const theoreticalFullAmount = computeSessionCashAmount(startDate, persons, {
      loyaltyUsed: false,
    });

    const cashAmountDue = computeSessionCashAmount(startDate, persons, {
      loyaltyUsed,
    });

    const loyaltyDiscountAmount = Number(
      (theoreticalFullAmount - cashAmountDue).toFixed(2)
    );

    return {
      ...slot,
      box_id: numericBoxId,
      persons,
      nb_personnes: persons,
      participants: persons,
      start_time: times.start_time,
      end_time: times.end_time,
      date: times.date,
      datetime: times.datetime,
      theoreticalFullAmount,
      cashAmountDue,
      loyaltyDiscountAmount,
    };
  });

  const totalBeforeDiscount = normalizedItems.reduce(
    (sum, item) => sum + item.theoreticalFullAmount,
    0
  );

  const loyaltyDiscount = normalizedItems.reduce(
    (sum, item) => sum + item.loyaltyDiscountAmount,
    0
  );

  const totalCashDue = normalizedItems.reduce(
    (sum, item) => sum + item.cashAmountDue,
    0
  );

  return {
    normalizedItems,
    totalBeforeDiscount: Number(totalBeforeDiscount.toFixed(2)),
    loyaltyDiscount: Number(loyaltyDiscount.toFixed(2)),
    totalCashDue: Number(totalCashDue.toFixed(2)),
  };
}

// ------------------------------------------------------
// Helpers profil users
// ------------------------------------------------------
async function updateUserProfileInUsersTable(userId, payload) {
  if (!supabase) return;

  const update = {
    prenom: safeText(payload.prenom, 80),
    nom: safeText(payload.nom, 80),
    telephone: safeText(payload.telephone, 40),
    pays: safeCountry(payload.pays) || "FR",
    adresse: safeText(payload.adresse, 160),
    complement: safeText(payload.complement, 160),
    cp: safeText(payload.cp, 20),
    ville: safeText(payload.ville, 80),
    naissance: safeBirthdate(payload.naissance),
    updated_at: new Date().toISOString(),
  };

  const { error } = await supabase.from("users").update(update).eq("id", userId);
  if (error) throw error;
}

// ------------------------------------------------------
// Promo
// ------------------------------------------------------
async function validatePromoCode(code, totalAmountEur) {
  if (!supabase) {
    return { ok: false, reason: "Supabase non configuré" };
  }
  if (!code) {
    return { ok: false, reason: "Code vide" };
  }

  const upperCode = String(code).trim().toUpperCase();

  const { data: promo, error } = await supabase
    .from("promo_codes")
    .select("*")
    .eq("code", upperCode)
    .single();

  if (error || !promo) {
    console.warn("Promo introuvable :", error);
    return { ok: false, reason: "Code introuvable" };
  }

  if (promo.is_active === false) {
    return { ok: false, reason: "Code inactif" };
  }

  const today = new Date().toISOString().slice(0, 10);

  if (promo.valid_from && today < promo.valid_from) {
    return { ok: false, reason: "Code pas encore valable" };
  }
  if (promo.valid_to && today > promo.valid_to) {
    return { ok: false, reason: "Code expiré" };
  }

  if (promo.max_uses && promo.used_count >= promo.max_uses) {
    return { ok: false, reason: "Nombre d'utilisations atteint" };
  }

  let discountAmount = 0;
  const type = promo.type;
  const value = Number(promo.value) || 0;

  if (type === "percent") {
    discountAmount = totalAmountEur * (value / 100);
  } else if (type === "fixed") {
    discountAmount = Math.min(totalAmountEur, value);
  } else if (type === "free") {
    discountAmount = totalAmountEur;
  }

  const newTotal = Math.max(0, totalAmountEur - discountAmount);

  return {
    ok: true,
    newTotal,
    discountAmount,
    promo,
  };
}

// ------------------------------------------------------
// Helpers auth / user
// ------------------------------------------------------
function getUserEmailOrThrow(user) {
  const email = String(user?.email || "").trim();
  if (!email) {
    throw new Error("Email utilisateur introuvable");
  }
  return email;
}

async function getUserById(userId) {
  if (!supabase) throw new Error("Supabase non configuré");
  const { data, error } = await supabase
    .from("users")
    .select(
      "id,email,points,stripe_customer_id,default_payment_method_id,card_brand,card_last4,card_exp_month,card_exp_year"
    )
    .eq("id", userId)
    .single();
  if (error) throw error;
  return data;
}

async function getAuthenticatedUserById(userId) {
  if (!supabase) throw new Error("Supabase non configuré");

  const { data, error } = await supabase
    .from("users")
    .select("id,email,points")
    .eq("id", userId)
    .single();

  if (error || !data) {
    throw new Error("Utilisateur introuvable");
  }

  return data;
}

async function getReservationOwnedByUser(reservationId, userId) {
  if (!supabase) throw new Error("Supabase non configuré");

  const user = await getAuthenticatedUserById(userId);
  const email = getUserEmailOrThrow(user);

  const { data, error } = await supabase
    .from("reservations")
    .select("*")
    .eq("id", reservationId)
    .eq("email", email)
    .single();

  if (error || !data) {
    return null;
  }

  return data;
}

// ------------------------------------------------------
// Stripe customer helpers
// ------------------------------------------------------
async function ensureStripeCustomer(userId) {
  if (!stripe) throw new Error("Stripe non configuré");
  if (!supabase) throw new Error("Supabase non configuré");

  const user = await getUserById(userId);

  if (user.stripe_customer_id) {
    return { customerId: user.stripe_customer_id, user };
  }

  const customer = await stripe.customers.create({
    email: user.email || undefined,
    metadata: { supabase_user_id: String(userId) },
  });

  const { error: upErr } = await supabase
    .from("users")
    .update({
      stripe_customer_id: customer.id,
      updated_at: new Date().toISOString(),
    })
    .eq("id", userId);

  if (upErr) throw upErr;

  const updated = await getUserById(userId);
  return { customerId: customer.id, user: updated };
}

async function saveDefaultCardToUsersTable(userId, paymentMethod) {
  if (!supabase) throw new Error("Supabase non configuré");

  const card = paymentMethod?.card || {};

  const update = {
    default_payment_method_id: paymentMethod.id,
    card_brand: card.brand ?? null,
    card_last4: card.last4 ?? null,
    card_exp_month: card.exp_month ?? null,
    card_exp_year: card.exp_year ?? null,
    updated_at: new Date().toISOString(),
  };

  const { error } = await supabase.from("users").update(update).eq("id", userId);
  if (error) throw error;
}

// ------------------------------------------------------
// Helpers conflits / updates
// ------------------------------------------------------
async function hasReservationConflict({
  boxId,
  startTime,
  endTime,
  excludeReservationId = null,
}) {
  if (!supabase) throw new Error("Supabase non configuré");

  let query = supabase
    .from("reservations")
    .select("id")
    .eq("box_id", boxId)
    .eq("status", "confirmed")
    .lt("start_time", endTime)
    .gt("end_time", startTime);

  if (excludeReservationId) {
    query = query.neq("id", excludeReservationId);
  }

  const { data, error } = await query;

  if (error) throw error;

  return Array.isArray(data) && data.length > 0;
}

async function tryUpdateReservationWithFallbacks(reservationId, payloadVariants) {
  let lastError = null;

  for (const payload of payloadVariants) {
    const { data, error } = await supabase
      .from("reservations")
      .update(payload)
      .eq("id", reservationId)
      .select()
      .single();

    if (!error) {
      return data;
    }

    lastError = error;
    console.warn("⚠️ Fallback update reservations :", error.message);
  }

  throw lastError || new Error("Impossible de mettre à jour la réservation");
}

async function updateInsertedReservationMetadata(reservationId, payloadVariants) {
  for (const payload of payloadVariants) {
    const { error } = await supabase
      .from("reservations")
      .update(payload)
      .eq("id", reservationId);

    if (!error) return true;
    console.warn("⚠️ Fallback metadata reservation :", error.message);
  }

  return false;
}

async function refundPointsToUser(userId, pointsToRefund) {
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

async function attemptStripePartialRefund(paymentIntentId, amountEur, reason = "requested_by_customer") {
  if (!stripe || !paymentIntentId || !amountEur || amountEur <= 0) {
    return { success: false, skipped: true };
  }

  const refund = await stripe.refunds.create({
    payment_intent: paymentIntentId,
    amount: Math.round(Number(amountEur) * 100),
    reason,
  });

  return { success: true, refund };
}

async function attemptRefundUsingReservationPaymentIntents(reservation, amountEur) {
  const candidates = [
    reservation?.modification_payment_intent_id,
    reservation?.latest_payment_intent_id,
    reservation?.payment_intent_id,
  ].filter(Boolean);

  if (!candidates.length) {
    return { success: false, skipped: true, reason: "Aucun payment_intent_id disponible" };
  }

  let lastError = null;

  for (const paymentIntentId of candidates) {
    try {
      const result = await attemptStripePartialRefund(paymentIntentId, amountEur);
      if (result.success) {
        return { success: true, paymentIntentId, refund: result.refund };
      }
    } catch (e) {
      lastError = e;
      console.warn("⚠️ Refund fallback Stripe :", e.message);
    }
  }

  return {
    success: false,
    skipped: false,
    reason: lastError?.message || "Impossible de rembourser via Stripe",
  };
}

async function attemptAutomaticSavedCardCharge({
  userId,
  customer,
  amountEur,
  metadata = {},
}) {
  if (!stripe) throw new Error("Stripe non configuré");
  if (!supabase) throw new Error("Supabase non configuré");

  const user = await getUserById(userId);
  const { customerId } = await ensureStripeCustomer(userId);

  const pmToUse = user.default_payment_method_id;
  if (!pmToUse) {
    return {
      success: false,
      requiresAdditionalPayment: true,
      reason: "Aucune carte enregistrée disponible",
    };
  }

  try {
    await stripe.paymentMethods.attach(pmToUse, { customer: customerId });
  } catch (e) {
    const msg = String(e?.message || "");
    if (!msg.toLowerCase().includes("already") && !msg.toLowerCase().includes("attached")) {
      throw e;
    }
  }

  const fullName =
    (customer?.prenom || "") + (customer?.prenom ? " " : "") + (customer?.nom || "");

  try {
    const pi = await stripe.paymentIntents.create({
      amount: Math.round(Number(amountEur) * 100),
      currency: "eur",
      customer: customerId,
      payment_method: pmToUse,
      payment_method_types: ["card"],
      confirm: true,
      off_session: true,
      metadata: {
        customer_email: customer?.email || user.email || "",
        customer_name: fullName,
        auto_modification_charge: "true",
        ...metadata,
      },
    });

    return {
      success: true,
      paymentIntent: pi,
    };
  } catch (e) {
    const code = e?.code || "";
    const paymentIntent = e?.raw?.payment_intent || null;

    if (
      code === "authentication_required" ||
      code === "card_declined" ||
      paymentIntent?.client_secret
    ) {
      return {
        success: false,
        requiresAdditionalPayment: true,
        clientSecret: paymentIntent?.client_secret || null,
        paymentIntentId: paymentIntent?.id || null,
        reason: e?.message || "Authentification ou nouvelle carte requise",
      };
    }

    throw e;
  }
}

// ------------------------------------------------------
// Email réservation
// ------------------------------------------------------
async function sendReservationEmail(reservation) {
  if (!mailEnabled || !resend) {
    console.warn("📧 Envoi mail désactivé (RESEND_API_KEY manquante) – email non envoyé.");
    return;
  }

  const toEmail = reservation.email;
  if (!toEmail) {
    console.warn("📧 Impossible d'envoyer l'email : pas d'adresse sur la réservation", reservation.id);
    return;
  }

  try {
    const qrText = `https://singbox-backend.onrender.com/api/check?id=${encodeURIComponent(
      reservation.id
    )}`;

    const qrDataUrl = await QRCode.toDataURL(qrText);
    const base64Qr = qrDataUrl.split(",")[1];

    const start = reservation.start_time ? new Date(reservation.start_time) : null;
    const end = reservation.end_time ? new Date(reservation.end_time) : null;

    const fmt = (d) =>
      d
        ? d.toLocaleString("fr-FR", {
            timeZone: "Europe/Paris",
            day: "2-digit",
            month: "2-digit",
            year: "numeric",
            hour: "2-digit",
            minute: "2-digit",
          })
        : "N/A";

    const startStr = fmt(start);
    const endStr = fmt(end);

    const subject = `Confirmation de votre réservation Singbox - Box ${reservation.box_id}`;

    const htmlBody = `
      <div style="margin:0;padding:22px 0;background:#050814;">
        <div style="max-width:720px;margin:0 auto;background:#020617;border-radius:18px;border:1px solid rgba(148,163,184,0.35);box-shadow:0 18px 45px rgba(0,0,0,0.85);overflow:hidden;">
          <div style="padding:18px 22px 20px 22px;background:radial-gradient(circle at 0% 0%,rgba(56,189,248,0.14),transparent 55%),radial-gradient(circle at 100% 0%,rgba(201,76,53,0.22),transparent 55%),#020617;color:#F9FAFB;font-family:system-ui,-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif;">
            <table width="100%" cellpadding="0" cellspacing="0" role="presentation" style="border-collapse:collapse;">
              <tr>
                <td style="vertical-align:top;">
                  <div style="font-weight:800;letter-spacing:0.22em;text-transform:uppercase;font-size:14px;line-height:1;">SINGBOX</div>
                  <div style="margin-top:6px;font-size:12px;color:#9CA3AF;">Karaoké box privatives · Toulouse</div>
                </td>
                <td align="right" style="vertical-align:top;">
                  <span style="display:inline-block;padding:7px 12px;border-radius:999px;background:rgba(15,23,42,0.85);border:1px solid rgba(148,163,184,0.45);font-size:11px;text-transform:uppercase;letter-spacing:0.12em;color:#E5E7EB;">
                    CONFIRMATION DE RÉSERVATION
                  </span>
                </td>
              </tr>
            </table>

            <div style="margin-top:16px;">
              <div style="font-size:22px;font-weight:900;letter-spacing:0.06em;text-transform:uppercase;">
                VOTRE SESSION EST CONFIRMÉE <span style="color:#22c55e;">✅</span>
              </div>
              <div style="margin-top:8px;font-size:13px;color:rgba(249,250,251,0.88);line-height:1.55;">
                Merci pour votre réservation chez <strong>Singbox</strong> ! Voici le récapitulatif de votre box karaoké privative.
              </div>
            </div>

            <div style="margin-top:16px;padding:14px 14px 12px 14px;border-radius:14px;background:rgba(15,23,42,0.75);border:1px solid rgba(148,163,184,0.38);">
              <table width="100%" cellpadding="0" cellspacing="0" role="presentation" style="border-collapse:collapse;">
                <tr>
                  <td style="font-size:12px;color:#9CA3AF;padding-bottom:8px;">Box réservée</td>
                  <td align="right" style="font-size:12px;color:#9CA3AF;padding-bottom:8px;">Horaires</td>
                </tr>
                <tr>
                  <td style="font-size:14px;font-weight:800;">Box ${reservation.box_id}</td>
                  <td align="right" style="font-size:13px;font-weight:700;color:#E5E7EB;">${startStr} – ${endStr}</td>
                </tr>
              </table>
            </div>

            <div style="margin-top:12px;padding:12px 14px;border-radius:14px;background:rgba(15,23,42,0.55);border:1px solid rgba(148,163,184,0.30);">
              <div style="font-size:12.5px;color:#E5E7EB;font-weight:700;">
                Votre QR code est en pièce jointe (fichier <span style="font-weight:900;">qr-reservation.png</span>).
              </div>
            </div>
          </div>
        </div>
      </div>
    `;

    const attachments = [
      {
        filename: "qr-reservation.png",
        content: base64Qr,
        contentType: "image/png",
      },
    ];

    await resend.emails.send({
      from: "Singbox <onboarding@resend.dev>",
      to: toEmail,
      subject,
      html: htmlBody,
      attachments,
    });

    console.log("✅ Email envoyé via Resend à", toEmail, "reservation", reservation.id);
  } catch (err) {
    console.error("❌ Erreur lors de l'envoi de l'email via Resend :", err);
  }
}

// ------------------------------------------------------
// Middleware JWT
// ------------------------------------------------------
function authMiddleware(req, res, next) {
  const authHeader = req.headers.authorization;
  const token = authHeader?.startsWith("Bearer ")
    ? authHeader.split(" ")[1]
    : null;

  if (!token) {
    return res.status(401).json({ error: "Token manquant" });
  }

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    req.userId = decoded.userId;
    next();
  } catch (err) {
    console.error("JWT erreur :", err);
    return res.status(401).json({ error: "Token invalide" });
  }
}

function optionalAuthMiddleware(req, _res, next) {
  try {
    const authHeader = req.headers.authorization;
    const token = authHeader?.startsWith("Bearer ")
      ? authHeader.split(" ")[1]
      : null;

    if (!token) return next();

    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    req.userId = decoded.userId;
    return next();
  } catch (_e) {
    return next();
  }
}

// ------------------------------------------------------
// WEBHOOK STRIPE
// ------------------------------------------------------
app.post(
  "/api/webhook",
  bodyParser.raw({ type: "application/json" }),
  async (req, res) => {
    if (!stripe || !STRIPE_WEBHOOK_SECRET) {
      console.error("❌ Webhook Stripe reçu mais non configuré");
      return res.status(500).send("Webhook non configuré");
    }

    const sig = req.headers["stripe-signature"];

    let event;
    try {
      event = stripe.webhooks.constructEvent(req.body, sig, STRIPE_WEBHOOK_SECRET);
    } catch (err) {
      console.error("❌ Erreur vérification signature webhook :", err.message);
      return res.status(400).send(`Webhook Error: ${err.message}`);
    }

    console.log("📩 Webhook Stripe reçu :", event.type);

    switch (event.type) {
      case "payment_intent.succeeded": {
        const paymentIntent = event.data.object;
        console.log(
          "✅ payment_intent.succeeded :",
          paymentIntent.id,
          "montant",
          paymentIntent.amount,
          "client",
          paymentIntent.metadata?.customer_email
        );
        break;
      }
      case "payment_intent.payment_failed": {
        const paymentIntent = event.data.object;
        console.warn(
          "⚠️ payment_intent.payment_failed :",
          paymentIntent.id,
          paymentIntent.last_payment_error?.message
        );
        break;
      }
      default:
        console.log(`ℹ️ Événement Stripe non géré : ${event.type}`);
    }

    res.json({ received: true });
  }
);

app.use(bodyParser.json());
console.log("🌍 CORS + JSON configurés");

// ------------------------------------------------------
// Vérifier panier
// ------------------------------------------------------
app.post("/api/verify-cart", async (req, res) => {
  try {
    if (!supabase) {
      return res.status(500).send("Supabase non configuré");
    }

    const { items } = req.body;

    if (!items || !Array.isArray(items) || items.length === 0) {
      return res.status(400).send("Panier vide ou invalide");
    }

    const normalizedItems = [];

    for (const slot of items) {
      const times = buildTimesFromSlot(slot);
      const rawBox = slot.boxId ?? slot.box_id ?? slot.box ?? slot.boxName ?? 1;
      const numericBoxId = getNumericBoxId(rawBox);

      const { data: conflicts, error: conflictError } = await supabase
        .from("reservations")
        .select("id")
        .eq("box_id", numericBoxId)
        .eq("status", "confirmed")
        .lt("start_time", times.end_time)
        .gt("end_time", times.start_time);

      if (conflictError) {
        console.error("Erreur vérification conflits /api/verify-cart :", conflictError);
        return res.status(500).send("Erreur serveur lors de la vérification des créneaux");
      }

      if (conflicts && conflicts.length > 0) {
        return res
          .status(409)
          .send(`Le créneau ${times.date} pour la box ${numericBoxId} n'est plus disponible.`);
      }

      const persons = clampPersons(slot.persons || slot.nb_personnes || 2);

      normalizedItems.push({
        ...slot,
        box_id: numericBoxId,
        persons,
        nb_personnes: persons,
        participants: persons,
        start_time: times.start_time,
        end_time: times.end_time,
        date: times.date,
      });
    }

    return res.json({ items: normalizedItems });
  } catch (e) {
    console.error("Erreur /api/verify-cart :", e);
    return res.status(500).send("Erreur serveur lors de la vérification du panier");
  }
});

// ------------------------------------------------------
// AUTH - INSCRIPTION
// ------------------------------------------------------
app.post("/api/register", async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ error: "Email et mot de passe requis" });
    }

    if (!supabase) {
      return res.status(500).json({ error: "Supabase non configuré" });
    }

    const hash = await bcrypt.hash(password, 10);

    const { error } = await supabase.from("users").insert({
      email,
      password_hash: hash,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });

    if (error) {
      console.error(error);
      return res.status(400).json({ error: error.message });
    }

    res.json({ message: "Compte créé" });
  } catch (err) {
    console.error("Erreur register :", err);
    res.status(500).json({ error: "Erreur serveur" });
  }
});

// ------------------------------------------------------
// AUTH - LOGIN
// ------------------------------------------------------
app.post("/api/login", async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ error: "Email et mot de passe requis" });
    }

    if (!supabase) {
      return res.status(500).json({ error: "Supabase non configuré" });
    }

    const { data: users, error } = await supabase
      .from("users")
      .select("*")
      .eq("email", email)
      .limit(1);

    if (error) return res.status(400).json({ error: error.message });

    const user = users && users[0];
    if (!user) return res.status(400).json({ error: "Email inconnu" });

    const ok = await bcrypt.compare(password, user.password_hash);
    if (!ok) return res.status(400).json({ error: "Mot de passe incorrect" });

    const token = jwt.sign({ userId: user.id }, process.env.JWT_SECRET, {
      expiresIn: "7d",
    });

    res.json({ token });
  } catch (err) {
    console.error("Erreur login :", err);
    res.status(500).json({ error: "Erreur serveur" });
  }
});

// ------------------------------------------------------
// PROFIL UTILISATEUR
// ------------------------------------------------------
app.get("/api/me", authMiddleware, async (req, res) => {
  try {
    const userId = req.userId;

    if (!supabase) {
      return res.status(500).json({ error: "Supabase non configuré" });
    }

    const { data: user, error: userErr } = await supabase
      .from("users")
      .select(
        "id,email,prenom,nom,telephone,pays,adresse,complement,cp,ville,naissance,points,stripe_customer_id,default_payment_method_id,card_brand,card_last4,card_exp_month,card_exp_year"
      )
      .eq("id", userId)
      .single();

    if (userErr) return res.status(400).json({ error: userErr.message });

    return res.json({
      id: user.id,
      email: user.email,
      points: user.points ?? 0,
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
    res.status(500).json({ error: "Erreur serveur" });
  }
});

app.post("/api/me", authMiddleware, async (req, res) => {
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

// ------------------------------------------------------
// Setup intent + cartes enregistrées
// ------------------------------------------------------
app.post("/api/create-setup-intent", authMiddleware, async (req, res) => {
  try {
    if (!stripe) return res.status(500).json({ error: "Stripe non configuré" });
    if (!supabase) return res.status(500).json({ error: "Supabase non configuré" });

    const { customerId } = await ensureStripeCustomer(req.userId);

    const setupIntent = await stripe.setupIntents.create({
      customer: customerId,
      payment_method_types: ["card"],
      usage: "off_session",
      metadata: { supabase_user_id: String(req.userId) },
    });

    return res.json({ clientSecret: setupIntent.client_secret });
  } catch (e) {
    console.error("Erreur /api/create-setup-intent :", e);
    return res.status(500).json({ error: "Erreur serveur (setup intent)" });
  }
});

app.get("/api/payment-methods", authMiddleware, async (req, res) => {
  try {
    if (!stripe) return res.status(500).json({ error: "Stripe non configuré" });
    if (!supabase) return res.status(500).json({ error: "Supabase non configuré" });

    const { customerId } = await ensureStripeCustomer(req.userId);

    const pms = await stripe.paymentMethods.list({
      customer: customerId,
      type: "card",
    });

    const user = await getUserById(req.userId);

    return res.json({
      customerId,
      defaultPaymentMethodId: user.default_payment_method_id ?? null,
      methods: (pms.data || []).map((pm) => ({
        id: pm.id,
        brand: pm.card?.brand ?? null,
        last4: pm.card?.last4 ?? null,
        exp_month: pm.card?.exp_month ?? null,
        exp_year: pm.card?.exp_year ?? null,
      })),
    });
  } catch (e) {
    console.error("Erreur /api/payment-methods :", e);
    return res.status(500).json({ error: "Erreur serveur (list payment methods)" });
  }
});

app.post("/api/set-default-payment-method", authMiddleware, async (req, res) => {
  try {
    if (!stripe) return res.status(500).json({ error: "Stripe non configuré" });
    if (!supabase) return res.status(500).json({ error: "Supabase non configuré" });

    const { paymentMethodId } = req.body || {};
    if (!paymentMethodId) {
      return res.status(400).json({ error: "paymentMethodId manquant" });
    }

    const { customerId } = await ensureStripeCustomer(req.userId);

    try {
      await stripe.paymentMethods.attach(paymentMethodId, { customer: customerId });
    } catch (e) {
      const msg = String(e?.message || "");
      if (!msg.toLowerCase().includes("already") && !msg.toLowerCase().includes("attached")) {
        throw e;
      }
    }

    await stripe.customers.update(customerId, {
      invoice_settings: { default_payment_method: paymentMethodId },
    });

    const pm = await stripe.paymentMethods.retrieve(paymentMethodId);
    await saveDefaultCardToUsersTable(req.userId, pm);

    return res.json({ ok: true });
  } catch (e) {
    console.error("Erreur /api/set-default-payment-method :", e);
    return res.status(500).json({ error: "Erreur serveur (set default PM)" });
  }
});

// ------------------------------------------------------
// MES RÉSERVATIONS
// ------------------------------------------------------
app.get("/api/my-reservations", authMiddleware, async (req, res) => {
  try {
    if (!supabase) {
      return res.status(500).json({ error: "Supabase non configuré" });
    }

    const userId = req.userId;

    const { data: user, error: userError } = await supabase
      .from("users")
      .select("email")
      .eq("id", userId)
      .single();

    if (userError || !user) {
      console.error("Erreur lecture user pour my-reservations :", userError);
      return res.status(400).json({ error: "Utilisateur introuvable" });
    }

    const { data: reservations, error } = await supabase
      .from("reservations")
      .select("*")
      .eq("email", user.email)
      .order("start_time", { ascending: false });

    if (error) {
      console.error("Erreur Supabase my-reservations :", error);
      return res.status(500).json({ error: "Erreur en chargeant les réservations" });
    }

    return res.json({ reservations: reservations || [] });
  } catch (e) {
    console.error("Erreur /api/my-reservations :", e);
    return res.status(500).json({ error: "Erreur serveur" });
  }
});

app.get("/api/my-reservations/:id", authMiddleware, async (req, res) => {
  try {
    if (!supabase) {
      return res.status(500).json({ error: "Supabase non configuré" });
    }

    const reservationId = req.params.id;
    const reservation = await getReservationOwnedByUser(reservationId, req.userId);

    if (!reservation) {
      return res.status(404).json({ error: "Réservation introuvable" });
    }

    return res.json({ reservation });
  } catch (e) {
    console.error("Erreur /api/my-reservations/:id :", e);
    return res.status(500).json({ error: "Erreur serveur" });
  }
});

// ------------------------------------------------------
// OPTIONS DE MODIFICATION
// ------------------------------------------------------
app.post("/api/reservation-modification-options", authMiddleware, async (req, res) => {
  try {
    if (!supabase) {
      return res.status(500).json({ error: "Supabase non configuré" });
    }

    const { reservationId } = req.body || {};

    if (!reservationId) {
      return res.status(400).json({ error: "reservationId manquant" });
    }

    const reservation = await getReservationOwnedByUser(reservationId, req.userId);
    if (!reservation) {
      return res.status(404).json({ error: "Réservation introuvable" });
    }

    if (!isReservationStatusModifiable(reservation.status)) {
      return res.status(400).json({ error: "Statut de réservation non modifiable" });
    }

    if (!isWithinModificationWindow(reservation.start_time)) {
      return res.status(400).json({
        error: `Modification impossible à moins de ${MODIFICATION_DEADLINE_HOURS}h avant la séance`,
      });
    }

    const currentStart = parseDateOrNull(reservation.start_time);
    if (!currentStart) {
      return res.status(400).json({ error: "Date de réservation invalide" });
    }

    const reservationDate = reservation.date || formatDateToYYYYMMDD(currentStart);
    const boxId = reservation.box_id;
    const currentPersons = getReservationPersons(reservation);
    const loyaltyUsed = isReservationPaidWithLoyalty(reservation);

    const options = [];

    for (const slotHour of STANDARD_SLOT_STARTS) {
      const { startIso, endIso } = buildSlotIsoRange(reservationDate, slotHour);
      const startDate = new Date(startIso);

      if (Math.abs(startDate.getTime() - currentStart.getTime()) < 60 * 1000) {
        continue;
      }

      if (!isWithinModificationWindow(startIso)) {
        continue;
      }

      const conflict = await hasReservationConflict({
        boxId,
        startTime: startIso,
        endTime: endIso,
        excludeReservationId: reservation.id,
      });

      if (conflict) {
        continue;
      }

      options.push({
        startTime: startIso,
        endTime: endIso,
        boxId,
        boxName: `Box ${boxId}`,
        estimatedAmount: computeSessionCashAmount(startDate, currentPersons, {
          loyaltyUsed,
        }),
      });
    }

    return res.json({
      reservationId: reservation.id,
      options,
      loyaltyUsed,
      currentPersons,
      loyaltyPointsUsed: getReservationLoyaltyPointsUsed(reservation),
    });
  } catch (e) {
    console.error("Erreur /api/reservation-modification-options :", e);
    return res.status(500).json({ error: "Erreur serveur" });
  }
});

// ------------------------------------------------------
// MODIFIER UNE RÉSERVATION
// ------------------------------------------------------
app.post("/api/modify-reservation", authMiddleware, async (req, res) => {
  try {
    if (!supabase) {
      return res.status(500).json({ error: "Supabase non configuré" });
    }

    const { reservationId, newStartTime, newEndTime, newPersons, boxId, customer } = req.body || {};

    if (!reservationId) {
      return res.status(400).json({ error: "reservationId manquant" });
    }

    const reservation = await getReservationOwnedByUser(reservationId, req.userId);
    if (!reservation) {
      return res.status(404).json({ error: "Réservation introuvable" });
    }

    if (!isReservationStatusModifiable(reservation.status)) {
      return res.status(400).json({ error: "Statut de réservation non modifiable" });
    }

    if (!isWithinModificationWindow(reservation.start_time)) {
      return res.status(400).json({
        error: `Modification impossible à moins de ${MODIFICATION_DEADLINE_HOURS}h avant la séance`,
      });
    }

    const safePersons = clampPersons(newPersons || getReservationPersons(reservation));

    const targetStart = parseDateOrNull(newStartTime || reservation.start_time);
    const targetEnd =
      parseDateOrNull(newEndTime) ||
      new Date(targetStart.getTime() + SLOT_DURATION_MINUTES * 60 * 1000);

    if (!targetStart || !targetEnd) {
      return res.status(400).json({ error: "Nouveau créneau invalide" });
    }

    if (!isWithinModificationWindow(targetStart.toISOString())) {
      return res.status(400).json({
        error: `Le nouveau créneau doit aussi être à plus de ${MODIFICATION_DEADLINE_HOURS}h de l'heure actuelle`,
      });
    }

    const targetBoxId = Number(boxId || reservation.box_id || 1);

    const conflict = await hasReservationConflict({
      boxId: targetBoxId,
      startTime: targetStart.toISOString(),
      endTime: targetEnd.toISOString(),
      excludeReservationId: reservation.id,
    });

    if (conflict) {
      return res.status(409).json({ error: "Le nouveau créneau n’est plus disponible" });
    }

    const loyaltyUsed = isReservationPaidWithLoyalty(reservation);
    const oldAmount = getReservationAmountPaid(reservation);
    const newAmount = computeSessionCashAmount(targetStart, safePersons, {
      loyaltyUsed,
    });
    const deltaAmount = Number((newAmount - oldAmount).toFixed(2));

    let modificationPaymentIntentId = null;
    let refundDone = false;

    if (deltaAmount > 0) {
      const autoCharge = await attemptAutomaticSavedCardCharge({
        userId: req.userId,
        customer: customer || { email: reservation.email, prenom: "", nom: "" },
        amountEur: deltaAmount,
        metadata: {
          reservation_id: String(reservation.id),
          modification_delta_amount: String(deltaAmount),
        },
      });

      if (!autoCharge.success) {
        return res.status(409).json({
          success: false,
          requiresAdditionalPayment: true,
          error: autoCharge.reason || "Paiement complémentaire requis",
          clientSecret: autoCharge.clientSecret || null,
          paymentIntentId: autoCharge.paymentIntentId || null,
          financial: {
            oldAmount,
            newAmount,
            deltaAmount,
            loyaltyUsed,
          },
        });
      }

      modificationPaymentIntentId = autoCharge.paymentIntent?.id || null;
    }

    if (deltaAmount < 0) {
      const refundAmount = Math.abs(deltaAmount);
      const refundResult = await attemptRefundUsingReservationPaymentIntents(reservation, refundAmount);

      if (!refundResult.success) {
        console.warn("⚠️ Remboursement Stripe partiel non effectué :", refundResult.reason || "non disponible");
      } else {
        refundDone = true;
      }
    }

    const newDateStr = formatDateToYYYYMMDD(targetStart);

    const richPayload = {
      start_time: targetStart.toISOString(),
      end_time: targetEnd.toISOString(),
      date: newDateStr,
      datetime: targetStart.toISOString(),
      box_id: targetBoxId,
      persons: safePersons,
      nb_personnes: safePersons,
      participants: safePersons,
      amount_paid: newAmount,
      montant: newAmount,
      total: newAmount,
      total_price: newAmount,
      latest_payment_intent_id: modificationPaymentIntentId || reservation.latest_payment_intent_id || reservation.payment_intent_id || null,
      modification_payment_intent_id: modificationPaymentIntentId || reservation.modification_payment_intent_id || null,
      updated_at: new Date().toISOString(),
    };

    const mediumPayload = {
      start_time: targetStart.toISOString(),
      end_time: targetEnd.toISOString(),
      date: newDateStr,
      datetime: targetStart.toISOString(),
      box_id: targetBoxId,
      persons: safePersons,
      nb_personnes: safePersons,
      participants: safePersons,
      montant: newAmount,
      total: newAmount,
      total_price: newAmount,
      updated_at: new Date().toISOString(),
    };

    const basePayload = {
      start_time: targetStart.toISOString(),
      end_time: targetEnd.toISOString(),
      date: newDateStr,
      datetime: targetStart.toISOString(),
      box_id: targetBoxId,
      updated_at: new Date().toISOString(),
    };

    const updatedReservation = await tryUpdateReservationWithFallbacks(reservation.id, [
      richPayload,
      mediumPayload,
      basePayload,
    ]);

    return res.json({
      success: true,
      message:
        deltaAmount > 0
          ? "Réservation modifiée avec paiement complémentaire validé."
          : deltaAmount < 0
            ? "Réservation modifiée et remboursement déclenché."
            : "Réservation modifiée avec succès.",
      reservation: updatedReservation,
      financial: {
        oldAmount,
        newAmount,
        deltaAmount,
        loyaltyUsed,
        refundDone,
      },
    });
  } catch (e) {
    console.error("Erreur /api/modify-reservation :", e);
    return res.status(500).json({ error: "Erreur serveur lors de la modification" });
  }
});

// ------------------------------------------------------
// POINTS FIDÉLITÉ
// ------------------------------------------------------
app.post("/api/add-points", authMiddleware, async (req, res) => {
  try {
    const userId = req.userId;
    const { points } = req.body;

    if (!points) {
      return res.status(400).json({ error: "Nombre de points manquant" });
    }

    if (!supabase) {
      return res.status(500).json({ error: "Supabase non configuré" });
    }

    const { error } = await supabase.rpc("increment_points", {
      user_id: userId,
      points_to_add: points,
    });

    if (error) {
      console.error(error);
      return res.status(400).json({ error: error.message });
    }

    res.json({ message: "Points ajoutés !" });
  } catch (err) {
    console.error("Erreur add-points :", err);
    res.status(500).json({ error: "Erreur serveur" });
  }
});

app.post("/api/use-loyalty", authMiddleware, async (req, res) => {
  try {
    const userId = req.userId;

    if (!supabase) {
      return res.status(500).json({ error: "Supabase non configuré" });
    }

    const { data: user, error } = await supabase
      .from("users")
      .select("points")
      .eq("id", userId)
      .single();

    if (error || !user) {
      return res.status(400).json({ error: "Utilisateur introuvable" });
    }

    if (user.points < LOYALTY_POINTS_COST) {
      return res.status(400).json({ error: "Pas assez de points" });
    }

    const { error: updateErr } = await supabase
      .from("users")
      .update({
        points: user.points - LOYALTY_POINTS_COST,
        updated_at: new Date().toISOString(),
      })
      .eq("id", userId);

    if (updateErr) {
      console.error(updateErr);
      return res.status(500).json({ error: "Impossible de retirer les points" });
    }

    return res.json({ success: true, message: `${LOYALTY_POINTS_COST} points utilisés` });
  } catch (e) {
    console.error("Erreur /api/use-loyalty :", e);
    return res.status(500).json({ error: "Erreur serveur" });
  }
});

// ------------------------------------------------------
// TEST
// ------------------------------------------------------
app.get("/", (req, res) => {
  res.send("API Singbox OK");
});

// ------------------------------------------------------
// Vacances
// ------------------------------------------------------
app.get("/api/is-vacances", (req, res) => {
  const date = req.query.date;
  if (!date) {
    return res.status(400).json({ error: "Paramètre 'date' manquant (YYYY-MM-DD)" });
  }

  const matchingPeriods = VACANCES_ZONE_C.filter((p) => isDateInRange(date, p.start, p.end));
  const isHoliday = matchingPeriods.length > 0;

  return res.json({
    vacances: isHoliday,
    is_vacances: isHoliday,
    zone: "C",
    date,
    periods: matchingPeriods,
  });
});

// ------------------------------------------------------
// PAYMENT INTENT
// ------------------------------------------------------
app.post("/api/create-payment-intent", optionalAuthMiddleware, async (req, res) => {
  try {
    if (!stripe) {
      return res.status(500).json({ error: "Stripe non configuré" });
    }

    console.log("/api/create-payment-intent appelé");
    const {
      panier,
      customer,
      promoCode,
      finalAmountCents,
      loyaltyUsed,
      useSavedPaymentMethod,
      paymentMethodId,
    } = req.body || {};

    if (!panier || !Array.isArray(panier) || panier.length === 0) {
      return res.status(400).json({ error: "Panier vide" });
    }

    const pricing = computeCartPricing(panier, { loyaltyUsed: !!loyaltyUsed });
    const theoreticalTotal = pricing.totalBeforeDiscount;
    const loyaltyDiscount = pricing.loyaltyDiscount;
    let totalAmountEur = pricing.totalCashDue;
    let promoDiscountAmount = 0;
    let promo = null;

    if (promoCode) {
      const result = await validatePromoCode(promoCode, totalAmountEur);
      if (result.ok) {
        totalAmountEur = result.newTotal;
        promoDiscountAmount = result.discountAmount;
        promo = result.promo;
      } else {
        console.warn("Code promo non appliqué :", result.reason);
      }
    }

    if (
      typeof finalAmountCents === "number" &&
      finalAmountCents >= 0 &&
      Number.isFinite(finalAmountCents)
    ) {
      const frontTotal = finalAmountCents / 100;
      if (Math.abs(frontTotal - totalAmountEur) > 0.01) {
        console.warn("⚠️ Écart entre total front et back :", "front=", frontTotal, "back=", totalAmountEur);
      }
    }

    console.log(
      "Montant théorique :",
      theoreticalTotal,
      "€ ; remise fidélité =",
      loyaltyDiscount,
      "€ ; remise promo =",
      promoDiscountAmount,
      "€ ; total cash dû =",
      totalAmountEur,
      "€"
    );

    if (totalAmountEur <= 0) {
      console.log("🟢 Séance gratuite : aucun PaymentIntent Stripe créé.");
      return res.json({
        isFree: true,
        totalBeforeDiscount: theoreticalTotal,
        loyaltyDiscount,
        promoDiscountAmount,
        totalAfterDiscount: 0,
        promo: promo
          ? { id: promo.id, code: promo.code, type: promo.type, value: promo.value }
          : null,
      });
    }

    const amountInCents = Math.round(totalAmountEur * 100);

    if (useSavedPaymentMethod) {
      if (!req.userId) {
        return res.status(401).json({ error: "Connexion requise pour payer avec carte enregistrée" });
      }
      if (!supabase) {
        return res.status(500).json({ error: "Supabase non configuré" });
      }

      const user = await getUserById(req.userId);
      const { customerId } = await ensureStripeCustomer(req.userId);

      const pmToUse = paymentMethodId || user.default_payment_method_id;
      if (!pmToUse) {
        return res.status(400).json({ error: "Aucune carte enregistrée disponible" });
      }

      try {
        await stripe.paymentMethods.attach(pmToUse, { customer: customerId });
      } catch (e) {
        const msg = String(e?.message || "");
        if (!msg.toLowerCase().includes("already") && !msg.toLowerCase().includes("attached")) {
          throw e;
        }
      }

      const fullName =
        (customer?.prenom || "") + (customer?.prenom ? " " : "") + (customer?.nom || "");

      try {
        const pi = await stripe.paymentIntents.create({
          amount: amountInCents,
          currency: "eur",
          customer: customerId,
          payment_method: pmToUse,
          payment_method_types: ["card"],
          metadata: {
            panier: JSON.stringify(pricing.normalizedItems),
            customer_email: customer?.email || "",
            customer_name: fullName,
            promo_code: promoCode || "",
            total_before_discount: String(theoreticalTotal),
            loyalty_discount_amount: String(loyaltyDiscount),
            promo_discount_amount: String(promoDiscountAmount),
            loyalty_used: loyaltyUsed ? "true" : "false",
            saved_card: "true",
          },
        });

        return res.json({
          clientSecret: pi.client_secret,
          paymentIntentId: pi.id,
          isFree: false,
          totalBeforeDiscount: theoreticalTotal,
          loyaltyDiscount,
          promoDiscountAmount,
          totalAfterDiscount: totalAmountEur,
          promo: promo ? { id: promo.id, code: promo.code, type: promo.type, value: promo.value } : null,
        });
      } catch (e) {
        const stripeMsg = e?.raw?.message || e?.message || "Erreur Stripe inconnue (saved card)";
        console.error("❌ Stripe saved-card PI error:", stripeMsg, e?.raw || e);

        return res.status(500).json({
          error: "Stripe saved-card: " + stripeMsg,
        });
      }
    }

    const paymentIntent = await stripe.paymentIntents.create({
      amount: amountInCents,
      currency: "eur",
      payment_method_types: ["card"],
      metadata: {
        panier: JSON.stringify(pricing.normalizedItems),
        customer_email: customer?.email || "",
        customer_name: (customer?.prenom || "") + " " + (customer?.nom || ""),
        promo_code: promoCode || "",
        total_before_discount: String(theoreticalTotal),
        loyalty_discount_amount: String(loyaltyDiscount),
        promo_discount_amount: String(promoDiscountAmount),
        loyalty_used: loyaltyUsed ? "true" : "false",
      },
    });

    return res.json({
      clientSecret: paymentIntent.client_secret,
      paymentIntentId: paymentIntent.id,
      isFree: false,
      totalBeforeDiscount: theoreticalTotal,
      loyaltyDiscount,
      promoDiscountAmount,
      totalAfterDiscount: totalAmountEur,
      promo: promo
        ? { id: promo.id, code: promo.code, type: promo.type, value: promo.value }
        : null,
    });
  } catch (err) {
    const msg = err?.raw?.message || err?.message || "Erreur serveur Stripe";
    console.error("Erreur create-payment-intent :", msg, err?.raw || err);
    return res.status(500).json({ error: msg });
  }
});

// ------------------------------------------------------
// CAUTION
// ------------------------------------------------------
app.post("/api/create-deposit-intent", optionalAuthMiddleware, async (req, res) => {
  try {
    if (!stripe) return res.status(500).json({ error: "Stripe non configuré" });

    const { reservationId, customer, useSavedPaymentMethod, paymentMethodId } = req.body || {};
    const amountInCents = Math.round(DEPOSIT_AMOUNT_EUR * 100);

    const fullName =
      (customer?.prenom || "") + (customer?.prenom ? " " : "") + (customer?.nom || "");

    if (useSavedPaymentMethod) {
      if (!req.userId) {
        return res.status(401).json({ error: "Connexion requise pour la caution avec carte enregistrée" });
      }
      if (!supabase) {
        return res.status(500).json({ error: "Supabase non configuré" });
      }

      const user = await getUserById(req.userId);
      const { customerId } = await ensureStripeCustomer(req.userId);

      const pmToUse = paymentMethodId || user.default_payment_method_id;
      if (!pmToUse) {
        return res.status(400).json({ error: "Aucune carte enregistrée disponible pour la caution" });
      }

      try {
        await stripe.paymentMethods.attach(pmToUse, { customer: customerId });
      } catch (e) {
        const msg = String(e?.message || "");
        if (!msg.toLowerCase().includes("already") && !msg.toLowerCase().includes("attached")) {
          throw e;
        }
      }

      const pi = await stripe.paymentIntents.create({
        amount: amountInCents,
        currency: "eur",
        customer: customerId,
        payment_method: pmToUse,
        payment_method_types: ["card"],
        capture_method: "manual",
        metadata: {
          type: "singbox_deposit",
          reservation_id: reservationId || "",
          customer_email: customer?.email || "",
          customer_name: fullName,
          saved_card: "true",
        },
      });

      if (supabase && reservationId) {
        try {
          await supabase
            .from("reservations")
            .update({
              deposit_payment_intent_id: pi.id,
              deposit_amount_cents: amountInCents,
              deposit_status: "created",
            })
            .eq("id", reservationId);
        } catch (e) {
          console.warn("⚠️ Impossible de mettre à jour les infos de caution :", e?.message || e);
        }
      }

      return res.json({
        clientSecret: pi.client_secret,
        paymentIntentId: pi.id,
        depositAmountEur: DEPOSIT_AMOUNT_EUR,
      });
    }

    const paymentIntent = await stripe.paymentIntents.create({
      amount: amountInCents,
      currency: "eur",
      capture_method: "manual",
      payment_method_types: ["card"],
      metadata: {
        type: "singbox_deposit",
        reservation_id: reservationId || "",
        customer_email: customer?.email || "",
        customer_name: fullName,
      },
    });

    if (supabase && reservationId) {
      try {
        await supabase
          .from("reservations")
          .update({
            deposit_payment_intent_id: paymentIntent.id,
            deposit_amount_cents: amountInCents,
            deposit_status: "created",
          })
          .eq("id", reservationId);
      } catch (e) {
        console.warn("⚠️ Impossible de mettre à jour les infos de caution :", e?.message || e);
      }
    }

    return res.json({
      clientSecret: paymentIntent.client_secret,
      paymentIntentId: paymentIntent.id,
      depositAmountEur: DEPOSIT_AMOUNT_EUR,
    });
  } catch (err) {
    console.error("Erreur create-deposit-intent :", err);
    const msg = err?.raw?.message || err?.message || "Erreur serveur Stripe (caution)";
    return res.status(500).json({ error: msg });
  }
});

// ------------------------------------------------------
// CONFIRM RESERVATION
// ------------------------------------------------------
app.post("/api/confirm-reservation", async (req, res) => {
  try {
    console.log("/api/confirm-reservation appelé");
    const { panier, customer, promoCode, paymentIntentId, loyaltyUsed, isFree } = req.body || {};

    if (!panier || !Array.isArray(panier) || panier.length === 0) {
      return res.status(400).json({ error: "Panier vide" });
    }

    const pricing = computeCartPricing(panier, { loyaltyUsed: !!loyaltyUsed });
    const theoreticalTotal = pricing.totalBeforeDiscount;
    const loyaltyDiscount = pricing.loyaltyDiscount;
    let totalCashDue = pricing.totalCashDue;

    let promoDiscountAmount = 0;
    let promo = null;

    if (promoCode) {
      const result = await validatePromoCode(promoCode, totalCashDue);
      if (result.ok) {
        totalCashDue = result.newTotal;
        promoDiscountAmount = result.discountAmount;
        promo = result.promo;
      } else {
        console.warn("Code promo non appliqué lors de confirm-reservation :", result.reason);
      }
    }

    const isFreeReservationFlag = !!isFree || totalCashDue <= 0;

    if (!isFreeReservationFlag) {
      if (!paymentIntentId) {
        return res.status(400).json({ error: "paymentIntentId manquant" });
      }
      if (!stripe) {
        return res.status(500).json({ error: "Stripe non configuré" });
      }

      const pi = await stripe.paymentIntents.retrieve(paymentIntentId);
      console.log("Statut PaymentIntent :", pi.status);
      if (pi.status !== "succeeded") {
        return res.status(400).json({ error: "Paiement non validé par Stripe" });
      }
    } else {
      console.log("✅ Réservation confirmée en mode gratuit.");
    }

    if (!supabase) {
      console.warn("⚠️ Supabase non configuré, réservation non enregistrée en base.");
      return res.json({ status: "ok (sans enregistrement Supabase)" });
    }

    let userIdFromToken = null;
    try {
      const authHeader = req.headers.authorization;
      const token = authHeader?.startsWith("Bearer ") ? authHeader.split(" ")[1] : null;
      if (token) {
        const decoded = jwt.verify(token, process.env.JWT_SECRET);
        userIdFromToken = decoded.userId;
      }
    } catch (e) {
      console.warn("⚠️ Token invalide sur /api/confirm-reservation :", e.message);
    }

    try {
      if (userIdFromToken && customer) {
        await updateUserProfileInUsersTable(userIdFromToken, customer);
      }
    } catch (e) {
      console.warn("⚠️ update users (confirm-reservation) a échoué:", e.message);
    }

    const fullName =
      (customer?.prenom || "") + (customer?.prenom ? " " : "") + (customer?.nom || "");

    const rowsBase = pricing.normalizedItems.map((slot) => ({
      name: fullName || null,
      email: customer?.email || null,
      box_id: slot.box_id,
      start_time: slot.start_time,
      end_time: slot.end_time,
      date: slot.date,
      datetime: slot.datetime,
      status: "confirmed",
    }));

    for (const row of rowsBase) {
      const { data: conflicts, error: conflictError } = await supabase
        .from("reservations")
        .select("id")
        .eq("box_id", row.box_id)
        .eq("status", "confirmed")
        .lt("start_time", row.end_time)
        .gt("end_time", row.start_time);

      if (conflictError) {
        console.error("Erreur vérification conflits :", conflictError);
        return res.status(500).json({ error: "Erreur serveur (vérification conflit)" });
      }

      if (conflicts && conflicts.length > 0) {
        return res.status(400).json({
          error: "Ce créneau est déjà réservé pour la box " + row.box_id + ".",
        });
      }
    }

    const { data, error } = await supabase.from("reservations").insert(rowsBase).select();

    if (error) {
      console.error("Erreur Supabase insert reservations :", error);
      return res.status(500).json({ error: "Erreur en enregistrant la réservation" });
    }

    for (let i = 0; i < data.length; i += 1) {
      const insertedReservation = data[i];
      const slot = pricing.normalizedItems[i];

      const metadataVariants = [
        {
          persons: slot.persons,
          nb_personnes: slot.persons,
          participants: slot.persons,
          amount_paid: slot.cashAmountDue,
          montant: slot.cashAmountDue,
          total: slot.cashAmountDue,
          total_price: slot.cashAmountDue,
          payment_mode: loyaltyUsed ? "loyalty" : isFreeReservationFlag ? "free" : "paid",
          payment_intent_id: paymentIntentId || null,
          latest_payment_intent_id: paymentIntentId || null,
          paid_with_loyalty: !!loyaltyUsed,
          used_loyalty_reward: !!loyaltyUsed,
          loyalty_reward_used: !!loyaltyUsed,
          loyalty_points_used: loyaltyUsed ? LOYALTY_POINTS_COST : 0,
          loyalty_free_people_count: loyaltyUsed ? LOYALTY_FREE_BILLABLE_PERSONS : 0,
          free_session: slot.cashAmountDue <= 0,
          is_free_session: slot.cashAmountDue <= 0,
          updated_at: new Date().toISOString(),
        },
        {
          persons: slot.persons,
          nb_personnes: slot.persons,
          participants: slot.persons,
          montant: slot.cashAmountDue,
          total: slot.cashAmountDue,
          total_price: slot.cashAmountDue,
          payment_mode: loyaltyUsed ? "loyalty" : isFreeReservationFlag ? "free" : "paid",
          payment_intent_id: paymentIntentId || null,
          paid_with_loyalty: !!loyaltyUsed,
          loyalty_points_used: loyaltyUsed ? LOYALTY_POINTS_COST : 0,
          updated_at: new Date().toISOString(),
        },
        {
          persons: slot.persons,
          nb_personnes: slot.persons,
          participants: slot.persons,
          montant: slot.cashAmountDue,
          total: slot.cashAmountDue,
          total_price: slot.cashAmountDue,
          updated_at: new Date().toISOString(),
        },
      ];

      await updateInsertedReservationMetadata(insertedReservation.id, metadataVariants);
    }

    try {
      await Promise.allSettled(data.map((row) => sendReservationEmail(row)));
    } catch (mailErr) {
      console.error("Erreur globale envoi mails :", mailErr);
    }

    try {
      const isActuallyFree = totalCashDue <= 0;
      if (userIdFromToken && !isActuallyFree) {
        const pointsToAdd = panier.length * 10;

        const { error: pointsError } = await supabase.rpc("increment_points", {
          user_id: userIdFromToken,
          points_to_add: pointsToAdd,
        });

        if (pointsError) {
          console.error("Erreur ajout points fidélité :", pointsError);
        }
      }
    } catch (pointsErr) {
      console.error("Erreur lors de l'ajout automatique des points :", pointsErr);
    }

    try {
      if (promo && promoDiscountAmount > 0) {
        const totalAfterDiscount = Math.max(0, totalCashDue);

        await supabase.from("promo_usages").insert({
          promo_id: promo.id,
          code: promo.code,
          email: customer?.email || null,
          payment_intent_id: paymentIntentId || null,
          total_before: pricing.totalCashDue,
          total_after: totalAfterDiscount,
          discount_amount: promoDiscountAmount,
        });

        const currentUsed = Number(promo.used_count || 0);
        await supabase
          .from("promo_codes")
          .update({ used_count: currentUsed + 1 })
          .eq("id", promo.id);
      }
    } catch (promoErr) {
      console.error("Erreur promo usages :", promoErr);
    }

    return res.json({
      status: "ok",
      reservations: data,
      pricing: {
        totalBeforeDiscount: theoreticalTotal,
        loyaltyDiscount,
        promoDiscountAmount,
        totalAfterDiscount: totalCashDue,
      },
      promo: promo
        ? {
            code: promo.code,
            discountAmount: promoDiscountAmount,
            totalBefore: pricing.totalCashDue,
            totalAfter: totalCashDue,
          }
        : null,
    });
  } catch (err) {
    console.error("Erreur confirm-reservation :", err);
    return res.status(500).json({ error: "Erreur serveur lors de la réservation" });
  }
});

// ------------------------------------------------------
// REMBOURSEMENT RÉSERVATION
// ------------------------------------------------------
app.post("/api/refund-reservation", authMiddleware, async (req, res) => {
  try {
    if (!supabase) {
      return res.status(500).json({ error: "Supabase non configuré" });
    }

    const { reservationId } = req.body || {};
    if (!reservationId) {
      return res.status(400).json({ error: "reservationId manquant" });
    }

    const reservation = await getReservationOwnedByUser(reservationId, req.userId);
    if (!reservation) {
      return res.status(404).json({ error: "Réservation introuvable" });
    }

    const start = parseDateOrNull(reservation.start_time);
    if (!start) {
      return res.status(400).json({ error: "Date de réservation invalide" });
    }

    const hoursBefore = (start.getTime() - Date.now()) / (1000 * 60 * 60);
    if (hoursBefore < 24) {
      return res.status(400).json({
        error: "Le remboursement n'est plus possible (moins de 24h avant la séance).",
      });
    }

    const loyaltyUsed = isReservationPaidWithLoyalty(reservation);
    const loyaltyPointsToRefund = loyaltyUsed ? getReservationLoyaltyPointsUsed(reservation) : 0;
    const cashAmountToRefund = getReservationAmountPaid(reservation);

    let stripeRefundDone = false;
    let loyaltyRefundDone = false;

    if (cashAmountToRefund > 0) {
      const refundResult = await attemptRefundUsingReservationPaymentIntents(
        reservation,
        cashAmountToRefund
      );

      if (refundResult.success) {
        stripeRefundDone = true;
      } else {
        console.warn("⚠️ Impossible de rembourser Stripe :", refundResult.reason || "pas de PI");
      }
    }

    if (loyaltyPointsToRefund > 0) {
      await refundPointsToUser(req.userId, loyaltyPointsToRefund);
      loyaltyRefundDone = true;
    }

    const updatedReservation = await tryUpdateReservationWithFallbacks(reservation.id, [
      {
        status: "cancelled",
        refunded_at: new Date().toISOString(),
        refund_amount: cashAmountToRefund,
        loyalty_refunded_points: loyaltyPointsToRefund,
        updated_at: new Date().toISOString(),
      },
      {
        status: "cancelled",
        updated_at: new Date().toISOString(),
      },
      {
        status: "cancelled",
      },
    ]);

    return res.json({
      success: true,
      message:
        loyaltyRefundDone && stripeRefundDone
          ? "Réservation annulée. Paiement remboursé et points recrédités."
          : loyaltyRefundDone
            ? "Réservation annulée. Les points de fidélité ont été recrédités."
            : stripeRefundDone
              ? "Réservation annulée. Le paiement a été remboursé."
              : "Réservation annulée.",
      reservation: updatedReservation,
      stripeRefundDone,
      loyaltyRefundDone,
      loyaltyPointsRefunded: loyaltyPointsToRefund,
      cashRefundAmount: cashAmountToRefund,
    });
  } catch (e) {
    console.error("Erreur /api/refund-reservation :", e);
    return res.status(500).json({ error: "Erreur serveur lors du remboursement" });
  }
});

// ------------------------------------------------------
// CAPTURE CAUTION
// ------------------------------------------------------
app.post("/api/capture-deposit", async (req, res) => {
  try {
    if (!stripe) {
      return res.status(500).json({ error: "Stripe non configuré" });
    }

    const { paymentIntentId, amountToCaptureEur, reservationId } = req.body;

    if (!paymentIntentId) {
      return res.status(400).json({ error: "paymentIntentId manquant pour la caution" });
    }

    const params = {};
    if (amountToCaptureEur != null) {
      params.amount_to_capture = Math.round(Number(amountToCaptureEur) * 100);
    }

    const paymentIntent = await stripe.paymentIntents.capture(paymentIntentId, params);

    if (supabase && reservationId) {
      try {
        await supabase
          .from("reservations")
          .update({ deposit_status: "captured" })
          .eq("id", reservationId);
      } catch (_e) {}
    }

    return res.json({ status: "captured", paymentIntent });
  } catch (err) {
    console.error("Erreur capture-deposit :", err);
    return res.status(500).json({ error: "Erreur serveur lors de la capture de la caution" });
  }
});

// ------------------------------------------------------
// ANNULER CAUTION
// ------------------------------------------------------
app.post("/api/cancel-deposit", async (req, res) => {
  try {
    if (!stripe) {
      return res.status(500).json({ error: "Stripe non configuré" });
    }

    const { paymentIntentId, reservationId } = req.body;

    if (!paymentIntentId) {
      return res.status(400).json({ error: "paymentIntentId manquant pour la caution" });
    }

    const canceled = await stripe.paymentIntents.cancel(paymentIntentId);

    if (supabase && reservationId) {
      try {
        await supabase
          .from("reservations")
          .update({ deposit_status: "canceled" })
          .eq("id", reservationId);
      } catch (_e) {}
    }

    return res.json({ status: "canceled", paymentIntent: canceled });
  } catch (err) {
    console.error("Erreur cancel-deposit :", err);
    return res.status(500).json({ error: "Erreur serveur lors de l'annulation de la caution" });
  }
});

// ------------------------------------------------------
// SLOTS
// ------------------------------------------------------
app.get("/api/slots", async (req, res) => {
  if (!supabase) {
    return res.status(500).json({ error: "Supabase non configuré" });
  }

  const date = req.query.date;
  if (!date) {
    return res.status(400).json({ error: "Paramètre 'date' manquant (YYYY-MM-DD)" });
  }

  try {
    const dayStartLocal = new Date(`${date}T00:00:00`);
    const dayEndLocal = new Date(`${date}T23:59:59`);

    const dayStartIso = dayStartLocal.toISOString();
    const dayEndIso = dayEndLocal.toISOString();

    const { data, error } = await supabase
      .from("reservations")
      .select("id, box_id, start_time, end_time, status")
      .eq("status", "confirmed")
      .gte("start_time", dayStartIso)
      .lte("start_time", dayEndIso);

    if (error) {
      console.error("Erreur /api/slots Supabase :", error);
      return res.status(500).json({ error: "Erreur serveur Supabase" });
    }

    return res.json({ reservations: data || [] });
  } catch (e) {
    console.error("Erreur /api/slots :", e);
    return res.status(500).json({ error: "Erreur serveur" });
  }
});

// ------------------------------------------------------
// QR CHECK
// ------------------------------------------------------
app.get("/api/check", async (req, res) => {
  if (!supabase) {
    return res.status(500).json({ valid: false, error: "Supabase non configuré" });
  }

  try {
    const id = req.query.id;

    if (!id) {
      res.status(400);
      return res.json({ valid: false, error: "Missing id" });
    }

    const { data, error } = await supabase
      .from("reservations")
      .select("*")
      .eq("id", id)
      .single();

    if (error || !data) {
      res.status(404);
      return res.json({ valid: false, reason: "Réservation introuvable." });
    }

    const now = new Date();
    const start = new Date(data.start_time);
    const end = new Date(data.end_time);

    const marginBeforeMinutes = 5;
    const marginBeforeEndMinutes = 5;

    const startWithMargin = new Date(start.getTime() - marginBeforeMinutes * 60000);
    const lastEntryTime = new Date(end.getTime() - marginBeforeEndMinutes * 60000);

    let access = false;
    let reason = "OK";

    if (now < startWithMargin) {
      access = false;
      reason = "Trop tôt pour accéder à la box.";
    } else if (now > lastEntryTime) {
      access = false;
      reason = "Créneau terminé, accès refusé.";
    } else if (data.status !== "confirmed") {
      access = false;
      reason = `Statut invalide : ${data.status}`;
    } else {
      access = true;
      reason = "Créneau valide, accès autorisé.";
    }

    return res.json({ valid: true, access, reason, reservation: data });
  } catch (e) {
    console.error("Erreur /api/check :", e);
    res.status(500);
    return res.json({ valid: false, error: e.message });
  }
});

// ------------------------------------------------------
// START SERVER
// ------------------------------------------------------
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log("✅ API Stripe/Supabase en écoute sur le port", PORT);
});
