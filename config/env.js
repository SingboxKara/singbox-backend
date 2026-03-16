// backend/config/env.js

import dotenv from "dotenv";

dotenv.config();

export const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY;
export const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET;

export const SUPABASE_URL = process.env.SUPABASE_URL;
export const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

export const RESEND_API_KEY = process.env.RESEND_API_KEY;
export const RESEND_FROM_EMAIL =
  process.env.RESEND_FROM_EMAIL || "Singbox <onboarding@resend.dev>";

export const FRONTEND_BASE_URL = (
  process.env.FRONTEND_BASE_URL || "https://www.singbox.fr"
).replace(/\/+$/, "");

export const BACKEND_BASE_URL = (
  process.env.BACKEND_BASE_URL ||
  (process.env.VERCEL_URL
    ? `https://${process.env.VERCEL_URL}`
    : "http://localhost:3000")
).replace(/\/+$/, "");

export const CRON_SECRET = process.env.CRON_SECRET || "";
export const REVIEW_REQUEST_EXPIRY_DAYS = Number(
  process.env.REVIEW_REQUEST_EXPIRY_DAYS || 30
);

export const JWT_SECRET = process.env.JWT_SECRET || "";
export const PORT = process.env.PORT || 3000;

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