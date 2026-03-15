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
import crypto from "crypto";

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
  console.warn(
    "⚠️ RESEND_API_KEY manquante : l'envoi d'email sera désactivé (pas de mails de confirmation)"
  );
}
if (!STRIPE_WEBHOOK_SECRET) {
  console.warn(
    "⚠️ STRIPE_WEBHOOK_SECRET manquant : les webhooks Stripe ne seront pas vérifiés"
  );
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

const MIN_ALLOWED_PERSONS = 1;
const MAX_ALLOWED_PERSONS = 8;
const MIN_BILLABLE_PERSONS = 2;

const LOYALTY_POINTS_COST = 100;
const LOYALTY_FREE_BILLABLE_PERSONS = 2;

const OFF_PEAK_START_HOUR = 4;
const OFF_PEAK_END_HOUR = 14;
const OFF_PEAK_RATE = 7.9;
const STANDARD_RATE = 9.9;

const CONFIRMED_STATUSES = [
  "confirmed",
  "confirmé",
  "confirmée",
  "confirme",
  "confirmee",
];

const CANCELLED_OR_REFUNDED_STATUSES = [
  "cancelled",
  "canceled",
  "annulé",
  "annule",
  "annulée",
  "annulee",
  "refunded",
  "refund",
  "remboursé",
  "rembourse",
  "remboursée",
  "remboursee",
];

const STANDARD_SLOT_STARTS = generateStandardSlotStarts();

// ---------- NOUVELLES CONSTANTES AVIS ----------
const FRONTEND_BASE_URL = (process.env.FRONTEND_BASE_URL || "https://www.singbox.fr").replace(/\/+$/, "");
const REVIEW_REQUEST_EXPIRY_DAYS = Number(process.env.REVIEW_REQUEST_EXPIRY_DAYS || 30);

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

function normalizeReservationStatus(statusRaw) {
  return String(statusRaw || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim()
    .toLowerCase();
}

function isReservationStatusConfirmed(statusRaw) {
  const s = normalizeReservationStatus(statusRaw);
  return CONFIRMED_STATUSES.map(normalizeReservationStatus).includes(s);
}

function isReservationStatusCancelledOrRefunded(statusRaw) {
  const s = normalizeReservationStatus(statusRaw);
  return CANCELLED_OR_REFUNDED_STATUSES
    .map(normalizeReservationStatus)
    .includes(s);
}

function isReservationStatusModifiable(statusRaw) {
  return isReservationStatusConfirmed(statusRaw);
}

function isWithinModificationWindow(startTimeIso) {
  const diff = hoursBeforeDate(startTimeIso);
  if (diff === null) return false;
  return diff >= MODIFICATION_DEADLINE_HOURS;
}

function generateStandardSlotStarts() {
  const slots = [];
  for (let mins = 0; mins <= 22 * 60 + 30; mins += SLOT_DURATION_MINUTES) {
    const hour = Math.floor(mins / 60);
    const minute = mins % 60;
    slots.push(hour + minute / 60);
  }
  return slots;
}

function areTimeRangesOverlapping(startA, endA, startB, endB) {
  const aStart = parseDateOrNull(startA);
  const aEnd = parseDateOrNull(endA);
  const bStart = parseDateOrNull(startB);
  const bEnd = parseDateOrNull(endB);

  if (!aStart || !aEnd || !bStart || !bEnd) return false;

  return aStart.getTime() < bEnd.getTime() && aEnd.getTime() > bStart.getTime();
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

function roundMoney(value) {
  return Number(Number(value || 0).toFixed(2));
}

// ------------------------------------------------------
// Helpers fidélité / pricing
// ------------------------------------------------------
function isReservationPaidWithLoyalty(reservation) {
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

function getReservationLoyaltyPointsUsed(reservation) {
  const n = Number(reservation?.points_spent);
  if (Number.isFinite(n) && n > 0) return n;
  return isReservationPaidWithLoyalty(reservation) ? LOYALTY_POINTS_COST : 0;
}

function getReservationPersons(reservation) {
  const n = Number(reservation?.persons);
  if (Number.isFinite(n) && n >= 1 && n <= 8) {
    return n;
  }
  return 2;
}

function getReservationAmountPaid(reservation) {
  const n = Number(reservation?.montant);
  if (Number.isFinite(n)) return n;
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
    const persons = clampPersons(
      slot.persons || slot.nb_personnes || slot.participants || 2
    );

    const billablePersons = getBillablePersons(persons);

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
      billablePersons,
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

function computeReservationTargetAmount({ reservation, targetStart, targetPersons }) {
  const loyaltyUsed = isReservationPaidWithLoyalty(reservation);

  return computeSessionCashAmount(targetStart, targetPersons, {
    loyaltyUsed,
  });
}

function computeModificationDelta({ reservation, targetStart, targetPersons }) {
  const oldAmount = roundMoney(reservation?.montant || 0);
  const newAmount = roundMoney(
    computeReservationTargetAmount({
      reservation,
      targetStart,
      targetPersons,
    })
  );

  return {
    oldAmount,
    newAmount,
    deltaAmount: roundMoney(newAmount - oldAmount),
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
// Helpers points fidélité
// ------------------------------------------------------
async function consumeLoyaltyPointsForUser(userId, pointsToSpend) {
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
async function getPotentiallyConflictingReservations({
  boxId,
  localDate,
  excludeReservationId = null,
}) {
  if (!supabase) throw new Error("Supabase non configuré");

  const candidateDates = [];
  if (localDate) {
    candidateDates.push(localDate);
    candidateDates.push(addDaysToDateString(localDate, -1));
    candidateDates.push(addDaysToDateString(localDate, 1));
  }

  let query = supabase
    .from("reservations")
    .select("id, box_id, start_time, end_time, status, date")
    .eq("box_id", boxId);

  if (candidateDates.length > 0) {
    query = query.in("date", [...new Set(candidateDates)]);
  }

  if (excludeReservationId) {
    query = query.neq("id", excludeReservationId);
  }

  const { data, error } = await query;

  if (error) throw error;

  return (data || []).filter((row) => isReservationStatusConfirmed(row.status));
}

async function hasReservationConflict({
  boxId,
  startTime,
  endTime,
  localDate = null,
  excludeReservationId = null,
}) {
  const reservations = await getPotentiallyConflictingReservations({
    boxId,
    localDate,
    excludeReservationId,
  });

  return reservations.some((row) =>
    areTimeRangesOverlapping(row.start_time, row.end_time, startTime, endTime)
  );
}

async function updateReservationById(reservationId, payload) {
  const { data, error } = await supabase
    .from("reservations")
    .update(payload)
    .eq("id", reservationId)
    .select()
    .single();

  if (error) throw error;
  return data;
}

function getReservationPaymentIntentCandidates(reservation) {
  return [
    reservation?.latest_payment_intent_id,
    reservation?.payment_intent_id,
    reservation?.original_payment_intent_id,
  ].filter(Boolean);
}

async function attemptAutomaticRefundAcrossPaymentIntents(reservation, refundAmountEur) {
  if (!stripe) throw new Error("Stripe non configuré");

  const candidates = getReservationPaymentIntentCandidates(reservation);
  if (!candidates.length || refundAmountEur <= 0) {
    return {
      success: false,
      skipped: true,
      reason: "Aucun payment_intent_id exploitable pour remboursement",
    };
  }

  let remaining = Math.round(refundAmountEur * 100);
  const refunds = [];

  for (const paymentIntentId of candidates) {
    if (remaining <= 0) break;

    try {
      const charges = await stripe.charges.list({
        payment_intent: paymentIntentId,
        limit: 100,
      });

      const chargeList = charges?.data || [];
      const totalCaptured = chargeList.reduce((sum, charge) => {
        return sum + Number(charge.amount_captured || charge.amount || 0);
      }, 0);

      const totalRefunded = chargeList.reduce((sum, charge) => {
        return sum + Number(charge.amount_refunded || 0);
      }, 0);

      const refundable = Math.max(0, totalCaptured - totalRefunded);
      if (refundable <= 0) continue;

      const refundNow = Math.min(remaining, refundable);

      if (refundNow > 0) {
        const refund = await stripe.refunds.create({
          payment_intent: paymentIntentId,
          amount: refundNow,
          reason: "requested_by_customer",
        });

        refunds.push(refund);
        remaining -= refundNow;
      }
    } catch (e) {
      console.warn("⚠️ Refund automatique impossible sur PI", paymentIntentId, e.message);
    }
  }

  if (remaining > 0) {
    return {
      success: false,
      skipped: false,
      partial: refunds.length > 0,
      refundedAmountEur: roundMoney((Math.round(refundAmountEur * 100) - remaining) / 100),
      reason: "Remboursement partiel ou impossible sur tous les paiements",
      refunds,
    };
  }

  return {
    success: true,
    refundedAmountEur: refundAmountEur,
    refunds,
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
// Helpers admin Supabase
// ------------------------------------------------------
function extractBearerToken(req) {
  const authHeader = req.headers.authorization;
  return authHeader?.startsWith("Bearer ")
    ? authHeader.split(" ")[1]
    : null;
}

function isSupabaseAdminUser(user) {
  const appRole = String(user?.app_metadata?.role || "").toLowerCase();
  const userRole = String(user?.user_metadata?.role || "").toLowerCase();
  const appIsAdmin = user?.app_metadata?.is_admin === true;
  const userIsAdmin = user?.user_metadata?.is_admin === true;
  const email = String(user?.email || "").trim().toLowerCase();

  return (
    appRole === "admin" ||
    userRole === "admin" ||
    appIsAdmin ||
    userIsAdmin ||
    email === "contactsingbox@gmail.com"
  );
}

async function requireSupabaseAdmin(req, res, next) {
  try {
    if (!supabase) {
      return res.status(500).json({ error: "Supabase non configuré" });
    }

    const token = extractBearerToken(req);
    if (!token) {
      return res.status(401).json({ error: "Token admin manquant" });
    }

    const { data, error } = await supabase.auth.getUser(token);

    if (error || !data?.user) {
      return res.status(401).json({ error: "Session admin invalide" });
    }

    if (!isSupabaseAdminUser(data.user)) {
      return res.status(403).json({ error: "Accès admin refusé" });
    }

    req.adminUser = data.user;
    next();
  } catch (e) {
    console.error("Erreur requireSupabaseAdmin :", e);
    return res.status(500).json({ error: "Erreur serveur auth admin" });
  }
}

// ------------------------------------------------------
// Envoi d'email
// ------------------------------------------------------
async function sendReservationEmail(reservation) {
  if (!mailEnabled || !resend) {
    console.warn(
      "📧 Envoi mail désactivé (RESEND_API_KEY manquante) – email non envoyé."
    );
    return;
  }

  const toEmail = reservation.email;
  if (!toEmail) {
    console.warn(
      "📧 Impossible d'envoyer l'email : pas d'adresse sur la réservation",
      reservation.id
    );
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
              <div style="margin-top:10px;font-size:12px;color:#E5E7EB;">
                <span style="font-weight:800;">Merci d’arriver 10 minutes en avance</span> afin de pouvoir vous installer et démarrer la session à l’heure.
              </div>
            </div>

            <div style="margin-top:12px;padding:12px 14px;border-radius:14px;background:rgba(15,23,42,0.55);border:1px solid rgba(148,163,184,0.30);">
              <div style="font-size:12.5px;color:#E5E7EB;font-weight:700;">
                Votre QR code est en pièce jointe (fichier <span style="font-weight:900;">qr-reservation.png</span>).
              </div>
              <div style="margin-top:6px;font-size:11.5px;color:#9CA3AF;">
                Présentez-le à l’accueil pour accéder à votre box.
              </div>
            </div>

            <div style="margin-top:12px;padding:14px 14px 12px 14px;border-radius:14px;background:rgba(8,12,22,0.65);border:1px solid rgba(248,113,113,0.45);">
              <div style="font-size:12.5px;font-weight:900;letter-spacing:0.08em;text-transform:uppercase;color:#FCA5A5;">
                EMPREINTE BANCAIRE DE ${DEPOSIT_AMOUNT_EUR} €
              </div>
              <div style="margin-top:8px;font-size:12px;color:#E5E7EB;line-height:1.55;">
                Pour garantir le bon déroulement de la session, une empreinte bancaire de ${DEPOSIT_AMOUNT_EUR} € peut être réalisée sur votre carte bancaire.
              </div>

              <ul style="margin:10px 0 0 18px;padding:0;color:#E5E7EB;font-size:12px;line-height:1.55;">
                <li>Il ne s’agit pas d’un débit immédiat, mais d’un blocage temporaire du montant.</li>
                <li>L’empreinte n’est pas encaissée si la session se déroule normalement et que le règlement est respecté.</li>
                <li>En cas de dégradations ou non-respect des règles, tout ou partie de ce montant peut être prélevée après constat par l’équipe Singbox.</li>
              </ul>

              <div style="margin-top:10px;font-size:11px;color:#9CA3AF;">
                Les délais de libération de l’empreinte dépendent de votre banque (généralement quelques jours).
              </div>
            </div>

            <div style="margin-top:16px;">
              <div style="font-size:12.5px;font-weight:900;letter-spacing:0.08em;text-transform:uppercase;color:#E5E7EB;">
                CONDITIONS D’ANNULATION
              </div>
              <ul style="margin:10px 0 0 18px;padding:0;color:#E5E7EB;font-size:12px;line-height:1.6;">
                <li>Annulation gratuite jusqu’à <strong>24h</strong> avant le début de la session.</li>
                <li>Passé ce délai, la réservation est considérée comme due et non remboursable.</li>
                <li>En cas de retard important, la session pourra être écourtée sans compensation afin de respecter les créneaux suivants.</li>
              </ul>
            </div>

            <div style="margin-top:14px;">
              <div style="font-size:12.5px;font-weight:900;letter-spacing:0.08em;text-transform:uppercase;color:#E5E7EB;">
                RÈGLEMENT INTÉRIEUR SINGBOX
              </div>
              <ul style="margin:10px 0 0 18px;padding:0;color:#E5E7EB;font-size:12px;line-height:1.6;">
                <li><strong>Respect du matériel :</strong> micros, écrans, banquettes et équipements doivent être utilisés avec soin.</li>
                <li><strong>Comportement :</strong> toute attitude violente, insultante ou dangereuse peut entraîner l’arrêt immédiat de la session.</li>
                <li><strong>Alcool & drogues :</strong> l’accès pourra être refusé en cas d’état d’ivresse avancé ou de consommation de substances illicites.</li>
                <li><strong>Fumée :</strong> il est strictement interdit de fumer dans les box.</li>
                <li><strong>Nuisances sonores :</strong> merci de respecter les autres clients et le voisinage dans les espaces communs.</li>
                <li><strong>Capacité maximale :</strong> le nombre de personnes par box ne doit pas dépasser la limite indiquée sur place.</li>
              </ul>

              <div style="margin-top:10px;font-size:11px;color:#9CA3AF;">
                En validant votre réservation, vous acceptez le règlement intérieur de Singbox.
              </div>
            </div>

            <div style="margin-top:14px;">
              <div style="font-size:12.5px;font-weight:900;letter-spacing:0.08em;text-transform:uppercase;color:#E5E7EB;">
                INFOS PRATIQUES
              </div>
              <div style="margin-top:10px;font-size:12px;color:#E5E7EB;line-height:1.6;">
                <div><strong>Adresse :</strong> 66 Rue de la République, 31300 Toulouse (à adapter si besoin).</div>
                <div style="margin-top:6px;color:#9CA3AF;font-size:11.5px;">Pensez à vérifier l’accès et le stationnement avant votre venue.</div>
              </div>
            </div>

            <div style="margin-top:16px;padding-top:14px;border-top:1px solid rgba(148,163,184,0.22);text-align:center;">
              <div style="font-size:11px;color:#9CA3AF;">Suivez-nous sur Instagram et TikTok : <strong style="color:#E5E7EB;">@singboxtoulouse</strong></div>
              <div style="margin-top:6px;font-size:11px;color:#9CA3AF;">Conservez cet e-mail, il vous sera demandé à l’arrivée.</div>
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
// NOUVEAUX HELPERS DEMANDES D'AVIS
// ------------------------------------------------------
function generateReviewToken() {
  return crypto.randomBytes(32).toString("hex");
}

function buildReviewLink(token) {
  return `${FRONTEND_BASE_URL}/laisser-un-avis?token=${encodeURIComponent(token)}`;
}

function getFirstNameFromReservation(reservation) {
  const name = String(reservation?.name || "").trim();
  if (!name) return null;
  const first = name.split(/\s+/)[0];
  return safeText(first, 80);
}

function addDaysToIsoNow(days) {
  return new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString();
}

function isReservationFinished(reservation) {
  const end = parseDateOrNull(reservation?.end_time);
  if (!end) return false;
  return end.getTime() < Date.now();
}

async function getReservationById(reservationId) {
  if (!supabase) throw new Error("Supabase non configuré");

  const { data, error } = await supabase
    .from("reservations")
    .select("*")
    .eq("id", reservationId)
    .single();

  if (error) throw error;
  return data;
}

async function getExistingReviewRequestByReservationId(reservationId) {
  if (!supabase) throw new Error("Supabase non configuré");

  const { data, error } = await supabase
    .from("review_requests")
    .select("*")
    .eq("reservation_id", String(reservationId))
    .maybeSingle();

  if (error) throw error;
  return data || null;
}

async function upsertReviewRequestForReservation(reservation) {
  if (!supabase) throw new Error("Supabase non configuré");

  const reservationId = String(reservation?.id || "").trim();
  const email = safeText(reservation?.email, 160);
  const firstName = getFirstNameFromReservation(reservation);

  if (!reservationId) {
    throw new Error("reservation.id manquant pour la demande d’avis");
  }
  if (!email) {
    throw new Error("reservation.email manquant pour la demande d’avis");
  }

  const existing = await getExistingReviewRequestByReservationId(reservationId);

  if (existing && existing.status === "used") {
    return {
      request: existing,
      alreadyUsed: true,
      created: false,
    };
  }

  const token = generateReviewToken();
  const nowIso = new Date().toISOString();
  const expiresAt = addDaysToIsoNow(REVIEW_REQUEST_EXPIRY_DAYS);

  const payload = {
    reservation_id: reservationId,
    email,
    name: firstName,
    token,
    status: "pending",
    sent_at: existing?.sent_at || null,
    used_at: null,
    expires_at: expiresAt,
    created_at: existing?.created_at || nowIso,
    updated_at: nowIso,
  };

  const { data, error } = await supabase
    .from("review_requests")
    .upsert(payload, { onConflict: "reservation_id" })
    .select()
    .single();

  if (error) throw error;

  return {
    request: data,
    alreadyUsed: false,
    created: !existing,
  };
}

async function markReviewRequestSent(reviewRequestId) {
  if (!supabase) throw new Error("Supabase non configuré");

  const nowIso = new Date().toISOString();

  const { error } = await supabase
    .from("review_requests")
    .update({
      sent_at: nowIso,
      updated_at: nowIso,
    })
    .eq("id", reviewRequestId);

  if (error) throw error;
}

async function getReviewRequestByToken(token) {
  if (!supabase) throw new Error("Supabase non configuré");

  const { data, error } = await supabase
    .from("review_requests")
    .select("*")
    .eq("token", token)
    .maybeSingle();

  if (error) throw error;
  return data || null;
}

async function markReviewRequestUsed(token) {
  if (!supabase) throw new Error("Supabase non configuré");

  const nowIso = new Date().toISOString();

  const { data, error } = await supabase
    .from("review_requests")
    .update({
      status: "used",
      used_at: nowIso,
      updated_at: nowIso,
    })
    .eq("token", token)
    .select()
    .single();

  if (error) throw error;
  return data;
}

async function expireReviewRequestIfNeeded(request) {
  if (!request) return null;
  if (request.status !== "pending") return request;

  const expiresAt = parseDateOrNull(request.expires_at);
  if (!expiresAt) return request;

  if (expiresAt.getTime() > Date.now()) {
    return request;
  }

  const { data, error } = await supabase
    .from("review_requests")
    .update({
      status: "expired",
      updated_at: new Date().toISOString(),
    })
    .eq("id", request.id)
    .select()
    .single();

  if (error) throw error;
  return data;
}

async function sendReviewRequestEmail(reservation) {
  if (!mailEnabled || !resend) {
    console.warn("📧 Envoi mail avis désactivé (RESEND_API_KEY manquante).");
    return { sent: false, reason: "mail_disabled" };
  }

  if (!reservation?.email) {
    console.warn("📧 Impossible d'envoyer le mail d'avis : email manquant", reservation?.id);
    return { sent: false, reason: "missing_email" };
  }

  const upsertResult = await upsertReviewRequestForReservation(reservation);

  if (upsertResult.alreadyUsed) {
    return { sent: false, reason: "already_used", reviewRequest: upsertResult.request };
  }

  const reviewRequest = upsertResult.request;
  const reviewLink = buildReviewLink(reviewRequest.token);

  try {
    const start = reservation.start_time ? new Date(reservation.start_time) : null;

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
    const firstName = safeText(reviewRequest.name || "bonjour", 80) || "bonjour";

    const subject = `Votre avis sur votre session Singbox`;

    const htmlBody = `
      <div style="margin:0;padding:22px 0;background:#050814;">
        <div style="max-width:720px;margin:0 auto;background:#020617;border-radius:18px;border:1px solid rgba(148,163,184,0.35);box-shadow:0 18px 45px rgba(0,0,0,0.85);overflow:hidden;">
          <div style="padding:22px;background:radial-gradient(circle at 0% 0%,rgba(56,189,248,0.14),transparent 55%),radial-gradient(circle at 100% 0%,rgba(201,76,53,0.22),transparent 55%),#020617;color:#F9FAFB;font-family:system-ui,-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif;">
            <div style="font-weight:800;letter-spacing:0.22em;text-transform:uppercase;font-size:14px;line-height:1;">SINGBOX</div>
            <div style="margin-top:6px;font-size:12px;color:#9CA3AF;">Karaoké box privatives · Toulouse</div>

            <div style="margin-top:18px;font-size:24px;font-weight:900;letter-spacing:0.04em;text-transform:uppercase;">
              MERCI POUR VOTRE VISITE 🎤
            </div>

            <div style="margin-top:10px;font-size:14px;line-height:1.65;color:rgba(249,250,251,0.9);">
              Bonjour ${firstName}, merci d’être venu chez <strong>Singbox</strong>.
              Votre session du <strong>${startStr}</strong> en <strong>Box ${reservation.box_id}</strong> s’est terminée, et votre retour nous aiderait beaucoup.
            </div>

            <div style="margin-top:18px;padding:16px;border-radius:16px;background:rgba(15,23,42,0.72);border:1px solid rgba(148,163,184,0.30);">
              <div style="font-size:13px;color:#E5E7EB;line-height:1.65;">
                Cliquez sur le bouton ci-dessous pour laisser votre avis.
                Ce lien est personnel et valable jusqu’au <strong>${new Date(reviewRequest.expires_at).toLocaleDateString("fr-FR")}</strong>.
              </div>

              <div style="margin-top:18px;text-align:center;">
                <a
                  href="${reviewLink}"
                  style="display:inline-block;padding:12px 22px;border-radius:999px;background:linear-gradient(90deg,#c94c35,#f97316);color:#F9FAFB;font-weight:800;font-size:14px;text-decoration:none;"
                >
                  Laisser mon avis
                </a>
              </div>
            </div>

            <div style="margin-top:16px;font-size:11px;color:#9CA3AF;line-height:1.6;">
              Si vous n’arrivez pas à cliquer sur le bouton, copiez-collez ce lien dans votre navigateur :
              <br />
              <span style="word-break:break-all;color:#E5E7EB;">${reviewLink}</span>
            </div>
          </div>
        </div>
      </div>
    `;

    await resend.emails.send({
      from: "Singbox <onboarding@resend.dev>",
      to: reservation.email,
      subject,
      html: htmlBody,
    });

    await markReviewRequestSent(reviewRequest.id);

    console.log("✅ Email de demande d'avis envoyé à", reservation.email, "reservation", reservation.id);

    return {
      sent: true,
      reviewRequest,
      reviewLink,
    };
  } catch (err) {
    console.error("❌ Erreur envoi email demande d'avis :", err);
    return {
      sent: false,
      reason: "mail_error",
      error: err.message,
      reviewRequest,
    };
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

      const hasConflict = await hasReservationConflict({
        boxId: numericBoxId,
        startTime: times.start_time,
        endTime: times.end_time,
        localDate: times.date,
      });

      if (hasConflict) {
        return res
          .status(409)
          .send(`Le créneau ${times.date} pour la box ${numericBoxId} n'est plus disponible.`);
      }

      const persons = clampPersons(slot.persons || slot.nb_personnes || 2);
      const price =
        typeof slot.price === "number" && !Number.isNaN(slot.price)
          ? slot.price
          : PRICE_PER_SLOT_EUR;

      normalizedItems.push({
        ...slot,
        price,
        box_id: numericBoxId,
        persons,
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

    if (!email || !password)
      return res.status(400).json({ error: "Email et mot de passe requis" });

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

    if (!email || !password)
      return res.status(400).json({ error: "Email et mot de passe requis" });

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
        localDate: reservationDate,
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
      slotStarts: STANDARD_SLOT_STARTS,
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

    const {
      reservationId,
      newStartTime,
      newEndTime,
      newPersons,
      boxId,
      customer,
    } = req.body || {};

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
    const targetLocalDate = formatDateToYYYYMMDD(targetStart);

    const conflict = await hasReservationConflict({
      boxId: targetBoxId,
      startTime: targetStart.toISOString(),
      endTime: targetEnd.toISOString(),
      localDate: targetLocalDate,
      excludeReservationId: reservation.id,
    });

    if (conflict) {
      return res.status(409).json({ error: "Le nouveau créneau n’est plus disponible" });
    }

    const loyaltyUsed = isReservationPaidWithLoyalty(reservation);

    const { oldAmount, newAmount, deltaAmount } = computeModificationDelta({
      reservation,
      targetStart,
      targetPersons: safePersons,
    });

    let autoChargeDone = false;
    let refundDone = false;
    let newPaymentIntentId = null;

    if (deltaAmount > 0) {
      const autoCharge = await attemptAutomaticSavedCardCharge({
        userId: req.userId,
        customer: customer || { email: reservation.email, prenom: "", nom: "" },
        amountEur: deltaAmount,
        metadata: {
          reservation_id: String(reservation.id),
          modification_delta_amount: String(deltaAmount),
          modification_type: "increase",
        },
      });

      if (!autoCharge.success) {
        return res.status(409).json({
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
            loyaltyUsed,
          },
        });
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
        return res.status(500).json({
          error:
            refundResult.reason ||
            "Impossible d’effectuer automatiquement le remboursement Stripe.",
          financial: {
            oldAmount,
            newAmount,
            deltaAmount,
            loyaltyUsed,
          },
        });
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
      billable_persons: getBillablePersons(safePersons),
      montant: newAmount,
      free_session: newAmount <= 0,
      loyalty_used: loyaltyUsed,
      points_spent: loyaltyUsed ? LOYALTY_POINTS_COST : 0,
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
        Number(reservation.refunded_amount || 0) + (deltaAmount < 0 ? Math.abs(deltaAmount) : 0)
      ),
      last_auto_charge_amount: deltaAmount > 0 ? deltaAmount : 0,
      updated_at: new Date().toISOString(),
    });

    return res.json({
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
        loyaltyUsed,
        autoChargeDone,
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
        console.warn(
          "⚠️ Écart entre total front et back :",
          "front=",
          frontTotal,
          "back=",
          totalAmountEur
        );
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

    if (loyaltyUsed && !req.userId) {
      return res.status(401).json({
        error: "Connexion requise pour utiliser les points de fidélité",
      });
    }

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
        const stripeMsg =
          e?.raw?.message || e?.message || "Erreur Stripe inconnue (saved card)";
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
// EMPREINTE DE CAUTION
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
        await updateReservationById(reservationId, {
          deposit_payment_intent_id: pi.id,
          deposit_amount_cents: amountInCents,
          deposit_status: "created",
          updated_at: new Date().toISOString(),
        });
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
      await updateReservationById(reservationId, {
        deposit_payment_intent_id: paymentIntent.id,
        deposit_amount_cents: amountInCents,
        deposit_status: "created",
        updated_at: new Date().toISOString(),
      });
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
  let userIdFromToken = null;
  let loyaltyPointsDebited = false;
  let loyaltyPointsDebitedAmount = 0;

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
        console.warn(
          "Code promo non appliqué lors de confirm-reservation :",
          result.reason
        );
      }
    }

    const isFreeReservationFlag = !!isFree || totalCashDue <= 0;

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

    if (loyaltyUsed && !userIdFromToken) {
      return res.status(401).json({
        error: "Connexion requise pour utiliser la fidélité",
      });
    }

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

    if (loyaltyUsed) {
      const loyaltyConsume = await consumeLoyaltyPointsForUser(
        userIdFromToken,
        LOYALTY_POINTS_COST
      );

      if (!loyaltyConsume.success) {
        return res.status(400).json({
          error: loyaltyConsume.reason || "Pas assez de points de fidélité",
          currentPoints: loyaltyConsume.currentPoints ?? null,
          requiredPoints: loyaltyConsume.requiredPoints ?? LOYALTY_POINTS_COST,
        });
      }

      loyaltyPointsDebited = true;
      loyaltyPointsDebitedAmount = LOYALTY_POINTS_COST;
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

    const rows = pricing.normalizedItems.map((slot) => ({
      name: fullName || null,
      email: customer?.email || null,
      datetime: slot.datetime,
      created_at: new Date().toISOString(),
      start_time: slot.start_time,
      box_id: slot.box_id,
      status: "confirmed",
      date: slot.date,
      end_time: slot.end_time,
      payment_intent_id: paymentIntentId || null,
      original_payment_intent_id: paymentIntentId || null,
      latest_payment_intent_id: paymentIntentId || null,
      deposit_payment_intent_id: null,
      deposit_amount_cents: 0,
      deposit_status: null,
      persons: slot.persons,
      billable_persons: slot.billablePersons,
      montant: slot.cashAmountDue,
      free_session: slot.cashAmountDue <= 0,
      loyalty_used: !!loyaltyUsed,
      points_spent: loyaltyUsed ? LOYALTY_POINTS_COST : 0,
      promo_code: promo?.code || null,
      refunded_amount: 0,
      last_auto_charge_amount: 0,
      updated_at: new Date().toISOString(),
    }));

    for (const row of rows) {
      const hasConflict = await hasReservationConflict({
        boxId: row.box_id,
        startTime: row.start_time,
        endTime: row.end_time,
        localDate: row.date,
      });

      if (hasConflict) {
        if (loyaltyPointsDebited && userIdFromToken && loyaltyPointsDebitedAmount > 0) {
          await refundPointsToUser(userIdFromToken, loyaltyPointsDebitedAmount);
        }

        return res.status(409).json({
          error: "Ce créneau est déjà réservé pour la box " + row.box_id + ".",
        });
      }
    }

    const insertedReservations = [];
    for (const row of rows) {
      const { data, error } = await supabase
        .from("reservations")
        .insert(row)
        .select()
        .single();

      if (error) {
        if (loyaltyPointsDebited && userIdFromToken && loyaltyPointsDebitedAmount > 0) {
          await refundPointsToUser(userIdFromToken, loyaltyPointsDebitedAmount);
        }

        console.error("Erreur Supabase insert reservations :", error);
        return res.status(500).json({ error: "Erreur en enregistrant la réservation" });
      }

      insertedReservations.push(data);
    }

    try {
      await Promise.allSettled(insertedReservations.map((row) => sendReservationEmail(row)));
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
      reservations: insertedReservations,
      pricing: {
        totalBeforeDiscount: theoreticalTotal,
        loyaltyDiscount,
        promoDiscountAmount,
        totalAfterDiscount: totalCashDue,
      },
      loyalty: {
        used: !!loyaltyUsed,
        pointsSpent: loyaltyUsed ? loyaltyPointsDebitedAmount : 0,
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
    if (loyaltyPointsDebited && userIdFromToken && loyaltyPointsDebitedAmount > 0) {
      try {
        await refundPointsToUser(userIdFromToken, loyaltyPointsDebitedAmount);
      } catch (refundErr) {
        console.error("❌ Impossible de recréditer les points après échec :", refundErr);
      }
    }

    console.error("Erreur confirm-reservation :", err);
    return res.status(500).json({ error: "Erreur serveur lors de la réservation" });
  }
});

// ------------------------------------------------------
// ADMIN - CRÉER UNE RÉSERVATION GRATUITE + MAIL + QR
// ------------------------------------------------------
app.post("/api/admin/create-free-reservation", requireSupabaseAdmin, async (req, res) => {
  try {
    if (!supabase) {
      return res.status(500).json({ error: "Supabase non configuré" });
    }

    const {
      name,
      email,
      date,
      box_id,
      start_minutes,
      persons,
      status,
    } = req.body || {};

    const safeName = safeText(name, 120);
    const safeEmail = safeText(email, 160);
    const safeDate = safeText(date, 10);
    const safeBoxId = getNumericBoxId(box_id);
    const safeStartMinutes = Number(start_minutes);
    const safePersons = clampPersons(persons || 2);
    const safeStatus = safeText(status, 40) || "confirmed";

    if (!safeName || !safeEmail || !safeDate) {
      return res.status(400).json({
        error: "name, email et date sont requis",
      });
    }

    if (!/^\d{4}-\d{2}-\d{2}$/.test(safeDate)) {
      return res.status(400).json({ error: "date invalide (YYYY-MM-DD attendu)" });
    }

    if (!Number.isFinite(safeStartMinutes) || safeStartMinutes < 0 || safeStartMinutes >= 24 * 60) {
      return res.status(400).json({ error: "start_minutes invalide" });
    }

    const hourFloat =
      Math.floor(safeStartMinutes / 60) + (safeStartMinutes % 60) / 60;
    const { startIso, endIso } = buildSlotIsoRange(safeDate, hourFloat);

    const hasConflict = await hasReservationConflict({
      boxId: safeBoxId,
      startTime: startIso,
      endTime: endIso,
      localDate: safeDate,
    });

    if (hasConflict) {
      return res.status(409).json({
        error: "Ce créneau est déjà réservé pour cette box",
      });
    }

    const reservationRow = {
      name: safeName,
      email: safeEmail,
      datetime: startIso,
      created_at: new Date().toISOString(),
      start_time: startIso,
      box_id: safeBoxId,
      status: safeStatus,
      date: safeDate,
      end_time: endIso,
      payment_intent_id: null,
      deposit_payment_intent_id: null,
      deposit_amount_cents: 0,
      deposit_status: null,
      persons: safePersons,
      billable_persons: getBillablePersons(safePersons),
      montant: 0,
      free_session: true,
      loyalty_used: false,
      points_spent: 0,
      promo_code: null,
      refunded_amount: 0,
      last_auto_charge_amount: 0,
      updated_at: new Date().toISOString(),
    };

    const { data: insertedReservation, error: insertError } = await supabase
      .from("reservations")
      .insert(reservationRow)
      .select()
      .single();

    if (insertError || !insertedReservation) {
      console.error("Erreur insert admin free reservation :", insertError);
      return res.status(500).json({
        error: "Impossible de créer la réservation gratuite",
      });
    }

    try {
      await sendReservationEmail(insertedReservation);
    } catch (mailErr) {
      console.error("Erreur envoi mail admin free reservation :", mailErr);
    }

    return res.json({
      success: true,
      reservation: insertedReservation,
    });
  } catch (e) {
    console.error("Erreur /api/admin/create-free-reservation :", e);
    return res.status(500).json({
      error: "Erreur serveur lors de la création de la réservation gratuite",
    });
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
    const loyaltyPointsToRefund = loyaltyUsed ? Number(getReservationLoyaltyPointsUsed(reservation)) : 0;
    const cashAmountToRefund = Number(reservation.montant || 0);

    let stripeRefundDone = false;
    let loyaltyRefundDone = false;

    if (cashAmountToRefund > 0) {
      const refundResult = await attemptAutomaticRefundAcrossPaymentIntents(
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

    const updatedReservation = await updateReservationById(reservation.id, {
      status: "cancelled",
      refunded_amount: roundMoney(
        Number(reservation.refunded_amount || 0) + cashAmountToRefund
      ),
      updated_at: new Date().toISOString(),
    });

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
      await updateReservationById(reservationId, {
        deposit_status: "captured",
        updated_at: new Date().toISOString(),
      });
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
      await updateReservationById(reservationId, {
        deposit_status: "canceled",
        updated_at: new Date().toISOString(),
      });
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
    const previousDate = addDaysToDateString(date, -1);

    const { data, error } = await supabase
      .from("reservations")
      .select("id, box_id, start_time, end_time, status, date")
      .in("date", [date, previousDate]);

    if (error) {
      console.error("Erreur /api/slots Supabase :", error);
      return res.status(500).json({ error: "Erreur serveur Supabase" });
    }

    const dayStart = new Date(`${date}T00:00:00+01:00`);
    const dayEnd = new Date(`${date}T23:59:59+01:00`);

    const reservations = (data || []).filter((row) => {
      if (!isReservationStatusConfirmed(row.status)) return false;

      const start = parseDateOrNull(row.start_time);
      const end = parseDateOrNull(row.end_time);
      if (!start || !end) return false;

      return start.getTime() <= dayEnd.getTime() && end.getTime() > dayStart.getTime();
    });

    return res.json({
      reservations,
      slotStarts: STANDARD_SLOT_STARTS,
    });
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

    if (isReservationStatusCancelledOrRefunded(data.status)) {
      access = false;
      reason = "Réservation annulée ou remboursée, accès refusé.";
    } else if (now < startWithMargin) {
      access = false;
      reason = "Trop tôt pour accéder à la box.";
    } else if (now > lastEntryTime) {
      access = false;
      reason = "Créneau terminé, accès refusé.";
    } else if (!isReservationStatusConfirmed(data.status)) {
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
// NOUVELLES ROUTES DEMANDES D'AVIS
// ------------------------------------------------------
app.post("/api/admin/send-review-request", requireSupabaseAdmin, async (req, res) => {
  try {
    if (!supabase) {
      return res.status(500).json({ error: "Supabase non configuré" });
    }

    const { reservationId } = req.body || {};
    if (!reservationId) {
      return res.status(400).json({ error: "reservationId manquant" });
    }

    const reservation = await getReservationById(reservationId);
    if (!reservation) {
      return res.status(404).json({ error: "Réservation introuvable" });
    }

    if (!isReservationStatusConfirmed(reservation.status)) {
      return res.status(400).json({
        error: "La réservation doit être confirmée pour envoyer une demande d’avis",
      });
    }

    if (!isReservationFinished(reservation)) {
      return res.status(400).json({
        error: "La séance n’est pas encore terminée",
      });
    }

    const result = await sendReviewRequestEmail(reservation);

    return res.json({
      success: result.sent,
      result,
    });
  } catch (e) {
    console.error("Erreur /api/admin/send-review-request :", e);
    return res.status(500).json({ error: "Erreur serveur lors de l’envoi de la demande d’avis" });
  }
});

app.post("/api/admin/send-completed-review-requests", requireSupabaseAdmin, async (req, res) => {
  try {
    if (!supabase) {
      return res.status(500).json({ error: "Supabase non configuré" });
    }

    const limit = Math.min(Math.max(Number(req.body?.limit || 20), 1), 100);
    const nowIso = new Date().toISOString();

    const { data: reservations, error } = await supabase
      .from("reservations")
      .select("*")
      .lt("end_time", nowIso)
      .order("end_time", { ascending: false })
      .limit(limit);

    if (error) {
      throw error;
    }

    const confirmedFinishedReservations = (reservations || []).filter(
      (row) => isReservationStatusConfirmed(row.status) && isReservationFinished(row)
    );

    const results = [];

    for (const reservation of confirmedFinishedReservations) {
      try {
        const existing = await getExistingReviewRequestByReservationId(reservation.id);

        if (existing?.status === "used") {
          results.push({
            reservationId: reservation.id,
            email: reservation.email,
            skipped: true,
            reason: "already_used",
          });
          continue;
        }

        if (existing?.sent_at && existing?.status === "pending") {
          results.push({
            reservationId: reservation.id,
            email: reservation.email,
            skipped: true,
            reason: "already_sent",
          });
          continue;
        }

        const sendResult = await sendReviewRequestEmail(reservation);

        results.push({
          reservationId: reservation.id,
          email: reservation.email,
          sent: !!sendResult.sent,
          reason: sendResult.reason || null,
        });
      } catch (itemErr) {
        console.error("Erreur envoi review request reservation", reservation.id, itemErr);
        results.push({
          reservationId: reservation.id,
          email: reservation.email,
          sent: false,
          reason: itemErr.message || "error",
        });
      }
    }

    return res.json({
      success: true,
      totalProcessed: results.length,
      results,
    });
  } catch (e) {
    console.error("Erreur /api/admin/send-completed-review-requests :", e);
    return res.status(500).json({ error: "Erreur serveur lors de l’envoi en lot des demandes d’avis" });
  }
});

app.get("/api/review-request/validate", async (req, res) => {
  try {
    if (!supabase) {
      return res.status(500).json({ error: "Supabase non configuré" });
    }

    const token = String(req.query.token || "").trim();
    if (!token) {
      return res.status(400).json({ valid: false, error: "token manquant" });
    }

    let request = await getReviewRequestByToken(token);

    if (!request) {
      return res.status(404).json({ valid: false, error: "Lien d’avis introuvable" });
    }

    request = await expireReviewRequestIfNeeded(request);

    if (request.status === "used") {
      return res.status(400).json({
        valid: false,
        error: "Ce lien d’avis a déjà été utilisé",
      });
    }

    if (request.status === "expired") {
      return res.status(400).json({
        valid: false,
        error: "Ce lien d’avis a expiré",
      });
    }

    const reservation = await getReservationById(request.reservation_id);

    return res.json({
      valid: true,
      request: {
        reservation_id: request.reservation_id,
        email: request.email,
        name: request.name,
        expires_at: request.expires_at,
        status: request.status,
      },
      reservation: reservation
        ? {
            id: reservation.id,
            email: reservation.email,
            name: reservation.name,
            start_time: reservation.start_time,
            end_time: reservation.end_time,
            box_id: reservation.box_id,
            status: reservation.status,
          }
        : null,
    });
  } catch (e) {
    console.error("Erreur /api/review-request/validate :", e);
    return res.status(500).json({ valid: false, error: "Erreur serveur" });
  }
});

app.post("/api/review-request/mark-used", async (req, res) => {
  try {
    if (!supabase) {
      return res.status(500).json({ error: "Supabase non configuré" });
    }

    const token = String(req.body?.token || "").trim();
    if (!token) {
      return res.status(400).json({ error: "token manquant" });
    }

    let request = await getReviewRequestByToken(token);

    if (!request) {
      return res.status(404).json({ error: "Lien d’avis introuvable" });
    }

    request = await expireReviewRequestIfNeeded(request);

    if (request.status === "expired") {
      return res.status(400).json({ error: "Lien expiré" });
    }

    if (request.status === "used") {
      return res.json({ success: true, alreadyUsed: true });
    }

    const updated = await markReviewRequestUsed(token);

    return res.json({
      success: true,
      request: updated,
    });
  } catch (e) {
    console.error("Erreur /api/review-request/mark-used :", e);
    return res.status(500).json({ error: "Erreur serveur" });
  }
});

// ------------------------------------------------------
// START SERVER
// ------------------------------------------------------
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log("✅ API Stripe/Supabase en écoute sur le port", PORT);
});