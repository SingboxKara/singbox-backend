import { supabase } from "../config/supabase.js";
import {
  safeText,
  safeCountry,
  safeBirthdate,
} from "../utils/validators.js";
import { ensureUserReferralCode } from "./referralService.js";

function ensureSupabase() {
  if (!supabase) {
    throw new Error("Supabase non configuré");
  }
}

function normalizeEmail(email) {
  return String(email || "").trim().toLowerCase();
}

function buildSafeUserProfileUpdate(payload = {}) {
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

  if (typeof payload.email === "string" && payload.email.trim()) {
    update.email = normalizeEmail(payload.email);
  }

  return update;
}

export async function updateUserProfileInUsersTable(userId, payload) {
  ensureSupabase();

  const safeUserId = safeText(userId, 120);
  if (!safeUserId) {
    throw new Error("userId manquant");
  }

  const update = buildSafeUserProfileUpdate(payload);

  const { error } = await supabase
    .from("users")
    .update(update)
    .eq("id", safeUserId);

  if (error) throw error;
}

export function getUserEmailOrThrow(user) {
  const email = String(user?.email || "").trim();
  if (!email) {
    throw new Error("Email utilisateur introuvable");
  }
  return email;
}

export async function getUserById(userId) {
  ensureSupabase();

  const safeUserId = safeText(userId, 120);
  if (!safeUserId) {
    throw new Error("userId manquant");
  }

  const { data, error } = await supabase
    .from("users")
    .select(
      [
        "id",
        "email",
        "prenom",
        "nom",
        "telephone",
        "pays",
        "adresse",
        "complement",
        "cp",
        "ville",
        "naissance",
        "singcoins",
        "stripe_customer_id",
        "default_payment_method_id",
        "card_brand",
        "card_last4",
        "card_exp_month",
        "card_exp_year",
        "referral_code",
        "referred_by_code",
      ].join(",")
    )
    .eq("id", safeUserId)
    .maybeSingle();

  if (error) throw error;
  if (!data) {
    throw new Error("Utilisateur introuvable");
  }

  if (data.id) {
    data.referral_code = await ensureUserReferralCode(data.id);
  }

  return data;
}

export async function getAuthenticatedUserById(userId) {
  ensureSupabase();

  const safeUserId = safeText(userId, 120);
  if (!safeUserId) {
    throw new Error("userId manquant");
  }

  const { data, error } = await supabase
    .from("users")
    .select(
      [
        "id",
        "email",
        "prenom",
        "nom",
        "telephone",
        "pays",
        "adresse",
        "complement",
        "cp",
        "ville",
        "naissance",
        "singcoins",
        "referral_code",
        "referred_by_code",
      ].join(",")
    )
    .eq("id", safeUserId)
    .maybeSingle();

  if (error || !data) {
    throw new Error("Utilisateur introuvable");
  }

  data.referral_code = await ensureUserReferralCode(data.id);

  return data;
}

async function resolveUserEmail(userId, userEmail) {
  const safeEmail = normalizeEmail(userEmail);
  if (safeEmail) return safeEmail;

  const safeUserId = safeText(userId, 120);
  if (!safeUserId) return null;

  ensureSupabase();

  const { data, error } = await supabase
    .from("users")
    .select("email")
    .eq("id", safeUserId)
    .maybeSingle();

  if (error) {
    throw error;
  }

  return data?.email ? normalizeEmail(data.email) : null;
}

export async function getReservationOwnedByUser(reservationId, userId, userEmail) {
  ensureSupabase();

  const safeReservationId = safeText(reservationId, 120);
  if (!safeReservationId) {
    return null;
  }

  const safeUserId = safeText(userId, 120);

  if (safeUserId) {
    const { data: direct, error: directError } = await supabase
      .from("reservations")
      .select("*")
      .eq("id", safeReservationId)
      .eq("user_id", safeUserId)
      .maybeSingle();

    if (directError) {
      throw directError;
    }

    if (direct) return direct;
  }

  const safeEmail = await resolveUserEmail(safeUserId, userEmail);
  if (!safeEmail) return null;

  const { data: fallback, error: fallbackError } = await supabase
    .from("reservations")
    .select("*")
    .eq("id", safeReservationId)
    .eq("email", safeEmail)
    .maybeSingle();

  if (fallbackError) {
    throw fallbackError;
  }

  return fallback || null;
}
