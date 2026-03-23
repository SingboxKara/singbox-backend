import { supabase } from "../config/supabase.js";
import {
  safeText,
  safeCountry,
  safeBirthdate,
} from "../utils/validators.js";
import { ensureUserReferralCode } from "./referralService.js";

export async function updateUserProfileInUsersTable(userId, payload) {
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

export function getUserEmailOrThrow(user) {
  const email = String(user?.email || "").trim();
  if (!email) {
    throw new Error("Email utilisateur introuvable");
  }
  return email;
}

export async function getUserById(userId) {
  if (!supabase) throw new Error("Supabase non configuré");

  const { data, error } = await supabase
    .from("users")
    .select(
      "id,email,points,stripe_customer_id,default_payment_method_id,card_brand,card_last4,card_exp_month,card_exp_year,telephone,referral_code,referred_by_code"
    )
    .eq("id", userId)
    .single();

  if (error) throw error;

  if (data?.id) {
    data.referral_code = await ensureUserReferralCode(data.id);
  }

  return data;
}

export async function getAuthenticatedUserById(userId) {
  if (!supabase) throw new Error("Supabase non configuré");

  const { data, error } = await supabase
    .from("users")
    .select("id,email,points,telephone,referral_code,referred_by_code")
    .eq("id", userId)
    .single();

  if (error || !data) {
    throw new Error("Utilisateur introuvable");
  }

  data.referral_code = await ensureUserReferralCode(data.id);

  return data;
}

async function resolveUserEmail(userId, userEmail) {
  if (userEmail) return String(userEmail).trim().toLowerCase();
  if (!userId || !supabase) return null;

  const { data } = await supabase
    .from("users")
    .select("email")
    .eq("id", userId)
    .maybeSingle();

  return data?.email ? String(data.email).trim().toLowerCase() : null;
}

export async function getReservationOwnedByUser(reservationId, userId, userEmail) {
  const { data: direct } = await supabase
    .from("reservations")
    .select("*")
    .eq("id", reservationId)
    .eq("user_id", userId)
    .maybeSingle();

  if (direct) return direct;

  const safeEmail = await resolveUserEmail(userId, userEmail);
  if (!safeEmail) return null;

  const { data: fallback } = await supabase
    .from("reservations")
    .select("*")
    .eq("id", reservationId)
    .eq("email", safeEmail)
    .maybeSingle();

  return fallback;
}