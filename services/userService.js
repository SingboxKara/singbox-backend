// backend/services/userService.js

import { supabase } from "../config/supabase.js";

function ensureSupabase() {
  if (!supabase) {
    throw new Error("Supabase non configuré");
  }
}

function safeText(value, maxLen = 255) {
  return String(value ?? "").trim().slice(0, maxLen);
}

function normalizeEmail(email) {
  return safeText(email, 255).toLowerCase();
}

function normalizeBirthdate(value) {
  const raw = safeText(value, 20);
  if (!raw) return null;
  return /^\d{4}-\d{2}-\d{2}$/.test(raw) ? raw : null;
}

function sanitizeUserUpdatePayload(payload = {}) {
  const input =
    payload && typeof payload === "object" && !Array.isArray(payload)
      ? payload
      : {};

  const out = {};

  if ("email" in input) out.email = normalizeEmail(input.email);
  if ("prenom" in input) out.prenom = safeText(input.prenom, 80);
  if ("nom" in input) out.nom = safeText(input.nom, 80);
  if ("telephone" in input) out.telephone = safeText(input.telephone, 40);
  if ("pays" in input) out.pays = safeText(input.pays, 20).toUpperCase() || "FR";
  if ("adresse" in input) out.adresse = safeText(input.adresse, 160);
  if ("complement" in input) out.complement = safeText(input.complement, 160);
  if ("cp" in input) out.cp = safeText(input.cp, 20);
  if ("ville" in input) out.ville = safeText(input.ville, 80);
  if ("naissance" in input) out.naissance = normalizeBirthdate(input.naissance);

  out.updated_at = new Date().toISOString();

  return out;
}

export async function getUserById(userId) {
  ensureSupabase();

  const id = safeText(userId, 120);
  if (!id) return null;

  const { data, error } = await supabase
    .from("users")
    .select(`
      id,
      email,
      singcoins_balance,
      created_at,
      updated_at,
      prenom,
      nom,
      telephone,
      pays,
      adresse,
      complement,
      cp,
      ville,
      naissance,
      stripe_customer_id,
      default_payment_method_id,
      card_brand,
      card_last4,
      card_exp_month,
      card_exp_year,
      referral_code,
      referred_by_code
    `)
    .eq("id", id)
    .maybeSingle();

  if (error) {
    console.error("getUserById error:", error);
    throw error;
  }

  return data || null;
}

export async function getUserByEmail(email) {
  ensureSupabase();

  const normalized = normalizeEmail(email);
  if (!normalized) return null;

  const { data, error } = await supabase
    .from("users")
    .select(`
      id,
      email,
      password_hash,
      singcoins_balance,
      created_at,
      updated_at,
      prenom,
      nom,
      telephone,
      pays,
      adresse,
      complement,
      cp,
      ville,
      naissance,
      stripe_customer_id,
      default_payment_method_id,
      card_brand,
      card_last4,
      card_exp_month,
      card_exp_year,
      referral_code,
      referred_by_code
    `)
    .eq("email", normalized)
    .maybeSingle();

  if (error) {
    console.error("getUserByEmail error:", error);
    throw error;
  }

  return data || null;
}

export async function updateUserProfileInUsersTable(userId, payload = {}) {
  ensureSupabase();

  const id = safeText(userId, 120);
  if (!id) {
    throw new Error("userId manquant");
  }

  const updatePayload = sanitizeUserUpdatePayload(payload);

  const { data, error } = await supabase
    .from("users")
    .update(updatePayload)
    .eq("id", id)
    .select(`
      id,
      email,
      singcoins_balance,
      created_at,
      updated_at,
      prenom,
      nom,
      telephone,
      pays,
      adresse,
      complement,
      cp,
      ville,
      naissance,
      stripe_customer_id,
      default_payment_method_id,
      card_brand,
      card_last4,
      card_exp_month,
      card_exp_year,
      referral_code,
      referred_by_code
    `)
    .maybeSingle();

  if (error) {
    console.error("updateUserProfileInUsersTable error:", error);
    throw error;
  }

  return data || null;
}

export async function getReservationOwnedByUser(
  reservationId,
  userId = null,
  fallbackEmail = null
) {
  ensureSupabase();

  const safeReservationId = safeText(reservationId, 120);
  if (!safeReservationId) return null;

  const { data, error } = await supabase
    .from("reservations")
    .select("*")
    .eq("id", safeReservationId)
    .maybeSingle();

  if (error) {
    console.error("getReservationOwnedByUser error:", error);
    throw error;
  }

  if (!data) return null;

  const safeUserId = safeText(userId, 120);
  const safeFallbackEmail = normalizeEmail(fallbackEmail);

  const reservationUserId = safeText(data.user_id, 120);
  const reservationEmail = normalizeEmail(data.email);

  const ownedByUserId =
    safeUserId && reservationUserId && String(reservationUserId) === String(safeUserId);

  const ownedByEmail =
    safeFallbackEmail &&
    reservationEmail &&
    reservationEmail === safeFallbackEmail;

  if (ownedByUserId || ownedByEmail) {
    return data;
  }

  return null;
}

export async function getReservationOwnedByEmail(reservationId, email) {
  return getReservationOwnedByUser(reservationId, null, email);
}

export async function getUserLightProfileById(userId) {
  ensureSupabase();

  const id = safeText(userId, 120);
  if (!id) return null;

  const { data, error } = await supabase
    .from("users")
    .select(`
      id,
      email,
      singcoins_balance,
      prenom,
      nom,
      telephone,
      pays,
      adresse,
      complement,
      cp,
      ville,
      naissance,
      created_at,
      updated_at,
      default_payment_method_id,
      card_brand,
      card_last4,
      card_exp_month,
      card_exp_year,
      referral_code,
      referred_by_code
    `)
    .eq("id", id)
    .maybeSingle();

  if (error) {
    console.error("getUserLightProfileById error:", error);
    throw error;
  }

  return data || null;
}

export {
  normalizeEmail,
  safeText,
  sanitizeUserUpdatePayload,
};
