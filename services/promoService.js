import { supabase } from "../config/supabase.js";

function getTodayIsoDate() {
  return new Date().toISOString().slice(0, 10);
}

function normalizePromoCode(code) {
  return String(code || "").trim().toUpperCase();
}

function normalizeEmail(email) {
  return String(email || "").trim().toLowerCase();
}

function normalizeAmount(amount) {
  const safeAmount = Number(amount);
  if (!Number.isFinite(safeAmount)) return 0;
  return Math.max(0, safeAmount);
}

function isLikelyPromoCode(code) {
  const safeCode = normalizePromoCode(code);
  if (!safeCode) return false;
  if (safeCode.length > 64) return false;
  return /^[A-Z0-9_-]+$/.test(safeCode);
}

function getEmailDomain(email) {
  const safeEmail = normalizeEmail(email);
  const atIndex = safeEmail.lastIndexOf("@");
  if (atIndex <= 0 || atIndex === safeEmail.length - 1) return null;
  return safeEmail.slice(atIndex + 1);
}

/**
 * Version SAFE pour le front :
 * on ne renvoie pas la logique interne exploitable.
 */
function sanitizePromoForClient(promo) {
  if (!promo) return null;

  return {
    id: promo.id ?? null,
    code: promo.code ?? null,
    type: promo.type ?? null,
    value: Number(promo.value) || 0,
    valid_from: promo.valid_from ?? null,
    valid_to: promo.valid_to ?? null,
  };
}

export async function getPromoByCode(code) {
  if (!supabase) {
    return { ok: false, reason: "Supabase non configuré", promo: null };
  }

  if (!isLikelyPromoCode(code)) {
    return { ok: false, reason: "Code invalide", promo: null };
  }

  const upperCode = normalizePromoCode(code);

  const { data: promo, error } = await supabase
    .from("promo_codes")
    .select(
      "id, code, type, value, is_active, valid_from, valid_to, max_uses, used_count, max_uses_per_user, first_session_only, email_domain, note"
    )
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
  const safeTotal = normalizeAmount(totalAmountEur);
  if (!promo || safeTotal <= 0) return 0;

  const type = String(promo.type || "").trim().toLowerCase();
  const value = Number(promo.value) || 0;

  let discountAmount = 0;

  if (type === "percent") {
    discountAmount = safeTotal * (value / 100);
  } else if (type === "fixed") {
    discountAmount = Math.min(safeTotal, value);
  } else if (type === "free") {
    discountAmount = safeTotal;
  }

  const safeDiscount = Math.max(0, Number(discountAmount) || 0);
  return Math.min(safeDiscount, safeTotal);
}

async function hasUserExceededPromoUsage(promo, email) {
  if (!supabase) return false;
  if (!promo?.id) return false;

  const safeEmail = normalizeEmail(email);
  if (!safeEmail) return false;

  const maxUsesPerUser =
    promo.max_uses_per_user === null || promo.max_uses_per_user === undefined
      ? null
      : Number(promo.max_uses_per_user);

  if (maxUsesPerUser === null || !Number.isFinite(maxUsesPerUser)) {
    return false;
  }

  const { count, error } = await supabase
    .from("promo_usages")
    .select("id", { count: "exact", head: true })
    .eq("promo_id", promo.id)
    .eq("email", safeEmail);

  if (error) {
    console.error("Erreur lecture promo_usages :", error);
    return false;
  }

  return Number(count || 0) >= maxUsesPerUser;
}

function parsePromoValidationContext(context = {}) {
  if (!context || typeof context !== "object" || Array.isArray(context)) {
    return {};
  }

  return {
    email: context.email ? normalizeEmail(context.email) : null,
    isFirstSession:
      typeof context.isFirstSession === "boolean" ? context.isFirstSession : null,
    enforceAdvancedRules: context.enforceAdvancedRules === true,
  };
}

export async function validatePromoCode(code, totalAmountEur = 0, context = {}) {
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

  const ctx = parsePromoValidationContext(context);

  if (ctx.enforceAdvancedRules) {
    if (promo.email_domain) {
      const requiredDomain = String(promo.email_domain).trim().toLowerCase();
      const currentDomain = getEmailDomain(ctx.email);

      if (!currentDomain) {
        return {
          ok: false,
          reason: "Email requis pour ce code promo",
          promo: sanitizePromoForClient(promo),
        };
      }

      if (currentDomain !== requiredDomain) {
        return {
          ok: false,
          reason: "Ce code promo n'est pas valable pour cet email",
          promo: sanitizePromoForClient(promo),
        };
      }
    }

    if (promo.first_session_only === true) {
      if (ctx.isFirstSession === null) {
        return {
          ok: false,
          reason: "Vérification de première réservation impossible",
          promo: sanitizePromoForClient(promo),
        };
      }

      if (ctx.isFirstSession !== true) {
        return {
          ok: false,
          reason: "Ce code promo est réservé à la première réservation",
          promo: sanitizePromoForClient(promo),
        };
      }
    }
  }

  if (ctx.email) {
    const exceeded = await hasUserExceededPromoUsage(promo, ctx.email);

    if (exceeded) {
      return {
        ok: false,
        reason: "Nombre d'utilisations atteint pour cet email",
        promo: sanitizePromoForClient(promo),
      };
    }
  }

  const safeTotal = normalizeAmount(totalAmountEur);
  const discountAmount = computePromoDiscount(promo, safeTotal);
  const newTotal = Math.max(0, safeTotal - discountAmount);

  return {
    ok: true,
    newTotal,
    discountAmount,
    promo,
    promoPublic: sanitizePromoForClient(promo),
  };
}

export { sanitizePromoForClient, normalizePromoCode, normalizeEmail };