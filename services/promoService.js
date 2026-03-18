// backend/services/promoService.js

import { supabase } from "../config/supabase.js";

function getTodayIsoDate() {
  return new Date().toISOString().slice(0, 10);
}

function sanitizePromoForClient(promo) {
  if (!promo) return null;

  return {
    id: promo.id ?? null,
    code: promo.code ?? null,
    type: promo.type ?? null,
    value: Number(promo.value) || 0,
    is_active: promo.is_active !== false,
    valid_from: promo.valid_from ?? null,
    valid_to: promo.valid_to ?? null,
    max_uses: promo.max_uses ?? null,
    used_count: promo.used_count ?? 0,
  };
}

export async function getPromoByCode(code) {
  if (!supabase) {
    return { ok: false, reason: "Supabase non configuré", promo: null };
  }

  if (!code) {
    return { ok: false, reason: "Code vide", promo: null };
  }

  const upperCode = String(code).trim().toUpperCase();

  const { data: promo, error } = await supabase
    .from("promo_codes")
    .select("*")
    .eq("code", upperCode)
    .maybeSingle();

  if (error) {
    console.error("Erreur lecture promo_codes :", error);
    return { ok: false, reason: "Erreur lecture promo", promo: null };
  }

  if (!promo) {
    return { ok: false, reason: "Code introuvable", promo: null };
  }

  return { ok: true, promo };
}

export function isPromoValidNow(promo) {
  if (!promo) {
    return { ok: false, reason: "Code introuvable" };
  }

  if (promo.is_active === false) {
    return { ok: false, reason: "Code inactif" };
  }

  const today = getTodayIsoDate();

  if (promo.valid_from && today < promo.valid_from) {
    return { ok: false, reason: "Code pas encore valable" };
  }

  if (promo.valid_to && today > promo.valid_to) {
    return { ok: false, reason: "Code expiré" };
  }

  const maxUses =
    promo.max_uses === null || promo.max_uses === undefined
      ? null
      : Number(promo.max_uses);

  const usedCount = Number(promo.used_count) || 0;

  if (maxUses !== null && Number.isFinite(maxUses) && usedCount >= maxUses) {
    return { ok: false, reason: "Nombre d'utilisations atteint" };
  }

  return { ok: true };
}

export function computePromoDiscount(promo, totalAmountEur) {
  const safeTotal = Math.max(0, Number(totalAmountEur) || 0);
  if (!promo || safeTotal <= 0) return 0;

  const type = promo.type;
  const value = Number(promo.value) || 0;

  let discountAmount = 0;

  if (type === "percent") {
    discountAmount = safeTotal * (value / 100);
  } else if (type === "fixed") {
    discountAmount = Math.min(safeTotal, value);
  } else if (type === "free") {
    discountAmount = safeTotal;
  }

  return Math.max(0, Number(discountAmount) || 0);
}

export async function validatePromoCode(code, totalAmountEur = 0) {
  const promoLookup = await getPromoByCode(code);

  if (!promoLookup.ok || !promoLookup.promo) {
    return {
      ok: false,
      reason: promoLookup.reason || "Code introuvable",
    };
  }

  const promo = promoLookup.promo;
  const validity = isPromoValidNow(promo);

  if (!validity.ok) {
    return {
      ok: false,
      reason: validity.reason,
      promo: sanitizePromoForClient(promo),
    };
  }

  const discountAmount = computePromoDiscount(promo, totalAmountEur);
  const newTotal = Math.max(0, (Number(totalAmountEur) || 0) - discountAmount);

  return {
    ok: true,
    newTotal,
    discountAmount,
    promo,
    promoPublic: sanitizePromoForClient(promo),
  };
}

export { sanitizePromoForClient };