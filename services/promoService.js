import { supabase } from "../config/supabase.js";

const MIN_BILLABLE_PERSONS = 2;
const CHEST_FREE_2P_MARKER = "CHEST_FREE_2P";

const WEEKDAY_MORNING_RATE = 4.99;
const WEEKDAY_MIDDAY_RATE = 8.99;
const WEEKDAY_EVENING_RATE = 10.99;
const WEEKEND_BEFORE_15_RATE = 11.99;
const WEEKEND_AFTER_15_RATE = 13.99;

const WEEKDAY_MORNING_START_HOUR = 8;
const WEEKDAY_MIDDAY_START_HOUR = 12;
const WEEKDAY_EVENING_START_HOUR = 15;
const WEEKDAY_END_NIGHT_HOUR = 2;
const WEEKEND_AFTERNOON_SWITCH_HOUR = 15;

const PARIS_TIME_ZONE = "Europe/Paris";

function ensureSupabase() {
  if (!supabase) {
    throw new Error("Supabase non configuré");
  }
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

function round2(value) {
  return Number(normalizeAmount(value).toFixed(2));
}

function isLikelyPromoCode(code) {
  const safeCode = normalizePromoCode(code);
  if (!safeCode) return false;
  if (safeCode.length > 64) return false;
  return /^[A-Z0-9_-]+$/.test(safeCode);
}

function getParisFormatter(options = {}) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: PARIS_TIME_ZONE,
    hourCycle: "h23",
    ...options,
  });
}

function getTodayIsoDate() {
  const formatter = getParisFormatter({
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });

  const parts = formatter.formatToParts(new Date());
  const map = Object.fromEntries(parts.map((part) => [part.type, part.value]));

  return `${map.year}-${map.month}-${map.day}`;
}

function getParisDateParts(date) {
  const formatter = getParisFormatter({
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    weekday: "short",
  });

  const parts = formatter.formatToParts(date);
  const map = Object.fromEntries(parts.map((part) => [part.type, part.value]));

  return {
    year: Number(map.year),
    month: Number(map.month),
    day: Number(map.day),
    hour: Number(map.hour),
    minute: Number(map.minute),
    second: Number(map.second),
    weekday: String(map.weekday || "").toLowerCase(),
  };
}

function parseDateOnlyToParisStart(dateStr) {
  const safe = String(dateStr || "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(safe)) return null;

  const date = new Date(`${safe}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) return null;
  return date;
}

function diffDaysFromParisDateOnly(dateStr) {
  const safe = String(dateStr || "").trim();
  if (!safe) return null;

  const today = getTodayIsoDate();
  const start = new Date(`${safe}T00:00:00Z`);
  const current = new Date(`${today}T00:00:00Z`);

  if (Number.isNaN(start.getTime()) || Number.isNaN(current.getTime())) {
    return null;
  }

  return (current.getTime() - start.getTime()) / (1000 * 60 * 60 * 24);
}

function getEmailDomain(email) {
  const safeEmail = normalizeEmail(email);
  const atIndex = safeEmail.lastIndexOf("@");
  if (atIndex <= 0 || atIndex === safeEmail.length - 1) return null;
  return safeEmail.slice(atIndex + 1);
}

function isPostSessionReviewPromo(promo) {
  const note = String(promo?.note || "").trim().toLowerCase();
  return note.startsWith("post_session_review_discount:");
}

function getPostSessionReviewPromoPercent(promo) {
  const validFrom = String(promo?.valid_from || "").trim();
  if (!validFrom) return 0;

  const diffDays = diffDaysFromParisDateOnly(validFrom);
  if (diffDays === null) return 0;

  if (diffDays < 0) return 0;
  if (diffDays < 2) return 30;
  if (diffDays < 7) return 20;
  if (diffDays <= 15) return 10;
  return 0;
}

function sanitizePromoForClient(promo) {
  if (!promo) return null;

  const computedValue = isPostSessionReviewPromo(promo)
    ? getPostSessionReviewPromoPercent(promo)
    : Number(promo.value) || 0;

  return {
    id: promo.id ?? null,
    code: promo.code ?? null,
    type: promo.type ?? null,
    value: computedValue,
    valid_from: promo.valid_from ?? null,
    valid_to: promo.valid_to ?? null,
  };
}

function normalizePersons(value) {
  const num = Number(value);
  if (!Number.isFinite(num)) return MIN_BILLABLE_PERSONS;
  return Math.max(1, Math.floor(num));
}

function getBillablePersons(persons) {
  return Math.max(normalizePersons(persons), MIN_BILLABLE_PERSONS);
}

function parseSlotDate(slot) {
  if (!slot || typeof slot !== "object") return null;

  const direct =
    slot.start_time ||
    slot.startTime ||
    slot.datetime ||
    null;

  if (direct) {
    const d = new Date(direct);
    if (!Number.isNaN(d.getTime())) return d;
  }

  if (slot.date && typeof slot.hour === "number") {
    const hour = Math.floor(slot.hour);
    const minute = Math.round((slot.hour - hour) * 60);
    const d = new Date(
      `${slot.date}T${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}:00`
    );
    if (!Number.isNaN(d.getTime())) return d;
  }

  if (slot.date && typeof slot.heure === "string") {
    const match = String(slot.heure).match(/(\d{1,2})[h:](\d{2})?/i);
    if (match) {
      const hour = Number(match[1]);
      const minute = Number(match[2] || 0);
      const d = new Date(
        `${slot.date}T${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}:00`
      );
      if (!Number.isNaN(d.getTime())) return d;
    }
  }

  if (slot.date) {
    const d = new Date(`${slot.date}T12:00:00`);
    if (!Number.isNaN(d.getTime())) return d;
  }

  return null;
}

function isWeekend(dateObj) {
  const weekday = getParisDateParts(dateObj).weekday;
  return weekday.startsWith("sun") || weekday.startsWith("sat");
}

function isFriday(dateObj) {
  const weekday = getParisDateParts(dateObj).weekday;
  return weekday.startsWith("fri");
}

function getPerPersonRate(dateObj) {
  const hour = getParisDateParts(dateObj).hour;
  const friday = isFriday(dateObj);
  const weekend = isWeekend(dateObj);

  if (friday || weekend) {
    if (hour >= WEEKEND_AFTERNOON_SWITCH_HOUR || hour < WEEKDAY_END_NIGHT_HOUR) {
      return WEEKEND_AFTER_15_RATE;
    }
    return WEEKEND_BEFORE_15_RATE;
  }

  if (hour >= WEEKDAY_MORNING_START_HOUR && hour < WEEKDAY_MIDDAY_START_HOUR) {
    return WEEKDAY_MORNING_RATE;
  }

  if (hour >= WEEKDAY_MIDDAY_START_HOUR && hour < WEEKDAY_EVENING_START_HOUR) {
    return WEEKDAY_MIDDAY_RATE;
  }

  if (hour >= WEEKDAY_EVENING_START_HOUR || hour < WEEKDAY_END_NIGHT_HOUR) {
    return WEEKDAY_EVENING_RATE;
  }

  return WEEKDAY_MORNING_RATE;
}

function isChestFreeTwoPersonsPromo(promo) {
  const note = String(promo?.note || "").toUpperCase();
  return (
    String(promo?.type || "").trim().toLowerCase() === "free" &&
    note.includes(CHEST_FREE_2P_MARKER)
  );
}

function computeChestFreeTwoPersonsDiscount(promo, totalAmountEur, panier = []) {
  const safeTotal = normalizeAmount(totalAmountEur);
  if (!promo || safeTotal <= 0) return 0;
  if (!Array.isArray(panier) || panier.length === 0) return 0;

  const firstItem = panier[0];
  const slotDate = parseSlotDate(firstItem);
  if (!slotDate) return 0;

  const persons = normalizePersons(
    firstItem?.persons ??
      firstItem?.nb_personnes ??
      firstItem?.participants ??
      2
  );

  const billablePersons = getBillablePersons(persons);
  const coveredPersons = Math.min(2, billablePersons);
  const perPersonRate = getPerPersonRate(slotDate);

  const firstItemFullAmount =
    typeof firstItem?.price === "number" && Number.isFinite(firstItem.price)
      ? Math.max(0, Number(firstItem.price))
      : Number((billablePersons * perPersonRate).toFixed(2));

  const discountAmount = Number((coveredPersons * perPersonRate).toFixed(2));

  return Math.min(
    safeTotal,
    firstItemFullAmount,
    Math.max(0, discountAmount)
  );
}

export async function getPromoByCode(code) {
  try {
    ensureSupabase();

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
  } catch (error) {
    console.error("Erreur getPromoByCode :", error);
    return { ok: false, reason: error?.message || "Erreur promo", promo: null };
  }
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

  if (isPostSessionReviewPromo(promo)) {
    const dynamicPercent = getPostSessionReviewPromoPercent(promo);
    if (dynamicPercent <= 0) {
      return { ok: false, reason: "Code expiré" };
    }
  }

  return { ok: true };
}

export function computePromoDiscount(promo, totalAmountEur, context = {}) {
  const safeTotal = normalizeAmount(totalAmountEur);
  if (!promo || safeTotal <= 0) return 0;

  const type = String(promo.type || "").trim().toLowerCase();
  const value = Number(promo.value) || 0;

  let discountAmount = 0;

  if (isChestFreeTwoPersonsPromo(promo)) {
    discountAmount = computeChestFreeTwoPersonsDiscount(
      promo,
      safeTotal,
      context?.panier || []
    );
  } else if (type === "percent") {
    if (isPostSessionReviewPromo(promo)) {
      const dynamicPercent = getPostSessionReviewPromoPercent(promo);
      if (dynamicPercent <= 0) {
        discountAmount = 0;
      } else {
        discountAmount = safeTotal * (dynamicPercent / 100);
      }
    } else {
      discountAmount = safeTotal * (value / 100);
    }
  } else if (type === "fixed") {
    discountAmount = Math.min(safeTotal, value);
  } else if (type === "free") {
    discountAmount = safeTotal;
  }

  const safeDiscount = Math.max(0, Number(discountAmount) || 0);
  return round2(Math.min(safeDiscount, safeTotal));
}

async function hasUserExceededPromoUsage(promo, email) {
  if (!promo?.id) return false;

  try {
    ensureSupabase();

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
  } catch (error) {
    console.error("Erreur hasUserExceededPromoUsage :", error);
    return false;
  }
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
    panier: Array.isArray(context.panier) ? context.panier : [],
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
  const discountAmount = computePromoDiscount(promo, safeTotal, ctx);
  const newTotal = round2(Math.max(0, safeTotal - discountAmount));

  return {
    ok: true,
    newTotal,
    discountAmount: round2(discountAmount),
    promo,
    promoPublic: sanitizePromoForClient(promo),
  };
}

export {
  sanitizePromoForClient,
  normalizePromoCode,
  normalizeEmail,
  isPostSessionReviewPromo,
  getPostSessionReviewPromoPercent,
};
