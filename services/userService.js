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
    .select("*")
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

// 🔥 FIX ICI
export async function getReservationOwnedByUser(reservationId, userId, userEmail) {
  // nouveau système
  let { data } = await supabase
    .from("reservations")
    .select("*")
    .eq("id", reservationId)
    .eq("user_id", userId)
    .maybeSingle();

  if (data) return data;

  // fallback email
  const { data: fallback } = await supabase
    .from("reservations")
    .select("*")
    .eq("id", reservationId)
    .eq("email", userEmail)
    .maybeSingle();

  return fallback;
}