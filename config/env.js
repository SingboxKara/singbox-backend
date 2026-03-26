// backend/config/env.js

import dotenv from "dotenv";

dotenv.config();

function readEnv(name, fallback = "") {
  const raw = process.env[name];

  if (raw == null) {
    return fallback;
  }

  return String(raw).trim();
}

function readUrlEnv(name, fallback = "") {
  return readEnv(name, fallback).replace(/\/+$/, "");
}

function readBooleanEnv(name, fallback = false) {
  const raw = readEnv(name, "");

  if (!raw) return fallback;

  const normalized = raw.toLowerCase();

  if (["true", "1", "yes", "y", "on"].includes(normalized)) return true;
  if (["false", "0", "no", "n", "off"].includes(normalized)) return false;

  return fallback;
}

function readNumberEnv(name, fallback) {
  const raw = readEnv(name, "");

  if (!raw) return fallback;

  const value = Number(raw);
  return Number.isFinite(value) ? value : fallback;
}

export const STRIPE_SECRET_KEY = readEnv("STRIPE_SECRET_KEY");
export const STRIPE_WEBHOOK_SECRET = readEnv("STRIPE_WEBHOOK_SECRET");

export const SUPABASE_URL = readEnv("SUPABASE_URL");
export const SUPABASE_SERVICE_ROLE_KEY = readEnv("SUPABASE_SERVICE_ROLE_KEY");

export const RESEND_API_KEY = readEnv("RESEND_API_KEY");
export const RESEND_FROM_EMAIL =
  readEnv("RESEND_FROM_EMAIL") || "Singbox <onboarding@resend.dev>";

export const FRONTEND_BASE_URL = readUrlEnv(
  "FRONTEND_BASE_URL",
  "https://site-reservation-qr.vercel.app"
);

export const BACKEND_BASE_URL = readUrlEnv(
  "BACKEND_BASE_URL",
  readEnv("RENDER_EXTERNAL_URL") ||
    (readEnv("VERCEL_URL") ? `https://${readEnv("VERCEL_URL")}` : "http://localhost:3000")
);

export const CRON_SECRET = readEnv("CRON_SECRET");
export const REVIEW_REQUEST_EXPIRY_DAYS = Math.max(
  1,
  readNumberEnv("REVIEW_REQUEST_EXPIRY_DAYS", 30)
);

export const JWT_SECRET = readEnv("JWT_SECRET");
export const PORT = Math.max(1, readNumberEnv("PORT", 3000));

// Scheduler auto des demandes d'avis
export const ENABLE_REVIEW_REQUEST_SCHEDULER = readBooleanEnv(
  "ENABLE_REVIEW_REQUEST_SCHEDULER",
  true
);

export const REVIEW_REQUEST_SCHEDULER_INTERVAL_MS = Math.max(
  60_000,
  readNumberEnv("REVIEW_REQUEST_SCHEDULER_INTERVAL_MS", 60 * 60 * 1000)
);

export const REVIEW_REQUEST_SCHEDULER_INITIAL_DELAY_MS = Math.max(
  5_000,
  readNumberEnv("REVIEW_REQUEST_SCHEDULER_INITIAL_DELAY_MS", 30_000)
);

export const REVIEW_REQUEST_BATCH_LIMIT = Math.min(
  Math.max(readNumberEnv("REVIEW_REQUEST_BATCH_LIMIT", 50), 1),
  100
);

// Logs utiles mais non bloquants pour éviter de casser le déploiement
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

if (!JWT_SECRET) {
  console.warn("⚠️ JWT_SECRET manquant : l'auth (login/register) va échouer");
}

if (!CRON_SECRET) {
  console.warn("⚠️ CRON_SECRET manquant : la route cron sécurisée ne fonctionnera pas");
}

if (!FRONTEND_BASE_URL) {
  console.warn("⚠️ FRONTEND_BASE_URL vide");
}

if (!BACKEND_BASE_URL) {
  console.warn("⚠️ BACKEND_BASE_URL vide");
}

console.log("✅ Config env chargée", {
  port: PORT,
  frontendBaseUrl: FRONTEND_BASE_URL,
  backendBaseUrl: BACKEND_BASE_URL,
  reviewSchedulerEnabled: ENABLE_REVIEW_REQUEST_SCHEDULER,
  reviewSchedulerIntervalMs: REVIEW_REQUEST_SCHEDULER_INTERVAL_MS,
  reviewSchedulerInitialDelayMs: REVIEW_REQUEST_SCHEDULER_INITIAL_DELAY_MS,
  reviewSchedulerBatchLimit: REVIEW_REQUEST_BATCH_LIMIT,
});
