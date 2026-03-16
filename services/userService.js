// backend/services/userService.js

import { supabase } from "../config/supabase.js";
import {
  safeText,
  safeCountry,
  safeBirthdate,
} from "../utils/validators.js";

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
      "id,email,points,stripe_customer_id,default_payment_method_id,card_brand,card_last4,card_exp_month,card_exp_year"
    )
    .eq("id", userId)
    .single();
  if (error) throw error;
  return data;
}

export async function getAuthenticatedUserById(userId) {
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

export async function getReservationOwnedByUser(reservationId, userId) {
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