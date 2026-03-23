import { supabase } from "../config/supabase.js";

const QUALIFYING_STATUSES = ["completed"];
const CANCELLED_STATUSES = [
  "cancelled",
  "annulee",
  "annulée",
  "refunded",
  "remboursee",
  "remboursée",
];

const BASE_RESERVATION_SINGCOINS = 10;
const BASE_RESERVATION_XP = 25;

const LEVEL_NAMES = [
  { min: 1, name: "Nouveau" },
  { min: 10, name: "Apprenti de scène" },
  { min: 20, name: "Voix montante" },
  { min: 30, name: "Performer du vendredi" },
  { min: 40, name: "Ambianceur confirmé" },
  { min: 50, name: "Tête d'affiche" },
  { min: 60, name: "Maître du micro" },
  { min: 70, name: "Bête de scène" },
  { min: 80, name: "Légende locale" },
  { min: 90, name: "Icône Singbox" },
  { min: 100, name: "Star absolue" },
];

function normalizeStatus(status) {
  return String(status || "").trim().toLowerCase();
}

function qualifiesForGamification(status) {
  return QUALIFYING_STATUSES.includes(normalizeStatus(status));
}

function computeLevel(xp) {
  const safeXp = Math.max(0, Number(xp || 0));
  const level = Math.min(100, Math.floor(safeXp / 100) + 1);
  const matched = [...LEVEL_NAMES].reverse().find((entry) => level >= entry.min);

  return {
    level,
    name: matched?.name || `Niveau ${level}`,
    xpCurrent: safeXp % 100,
    xpNext: 100,
  };
}

function toIsoDate(value) {
  if (!value) return null;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString().slice(0, 10);
}

function getMondayKey(value) {
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return null;

  const day = d.getUTCDay();
  const diff = day === 0 ? -6 : 1 - day;
  d.setUTCDate(d.getUTCDate() + diff);
  d.setUTCHours(0, 0, 0, 0);

  return d.toISOString().slice(0, 10);
}

function diffDaysUtc(aIso, bIso) {
  const a = new Date(`${aIso}T00:00:00.000Z`).getTime();
  const b = new Date(`${bIso}T00:00:00.000Z`).getTime();
  return Math.round((a - b) / 86400000);
}

function buildStreakFromWeekKeys(weekKeys) {
  if (!weekKeys.length) {
    return { current: 0, best: 0, lastKey: null };
  }

  const sorted = [...new Set(weekKeys)].sort();
  let best = 1;
  let currentRun = 1;

  for (let i = 1; i < sorted.length; i += 1) {
    const gap = diffDaysUtc(sorted[i], sorted[i - 1]);
    if (gap === 7) {
      currentRun += 1;
      if (currentRun > best) best = currentRun;
    } else {
      currentRun = 1;
    }
  }

  let current = 1;
  for (let i = sorted.length - 1; i > 0; i -= 1) {
    const gap = diffDaysUtc(sorted[i], sorted[i - 1]);
    if (gap === 7) current += 1;
    else break;
  }

  return {
    current,
    best,
    lastKey: sorted[sorted.length - 1],
  };
}

function mapBadgeIcon(icon) {
  const iconMap = {
    sparkles: "🎤",
    mic: "🔁",
    clock3: "⏱️",
    calendar: "📅",
    users: "👥",
    trophy: "🏆",
    flame: "🔥",
    gift: "🎁",
    star: "👑",
    crown: "🐐",
    bolt: "🔁",
    moon: "🌙",
    target: "🎯",
    gem: "🎉",
    rocket: "🚀",
    fire: "🔥",
  };

  return iconMap[icon] || "★";
}

function formatHoursFromMinutes(totalMinutes) {
  const minutes = Math.max(0, Math.floor(Number(totalMinutes || 0)));
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;

  if (!minutes) return "0h";
  if (!m) return `${h}h`;
  return `${h}h${String(m).padStart(2, "0")}`;
}

function getValidReservationDate(row) {
  const raw = row?.completed_at || row?.start_time || null;
  if (!raw) return null;
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) return null;
  return d;
}

function countGroupSessions(reservations, minPersons) {
  return (reservations || []).filter(
    (row) =>
      qualifiesForGamification(row.status) &&
      Number(row.persons || 0) >= Number(minPersons || 0)
  ).length;
}

function hasAtLeastNSessionsInRollingDays(reservations, minSessions, windowDays) {
  const dates = (reservations || [])
    .filter((row) => qualifiesForGamification(row.status))
    .map(getValidReservationDate)
    .filter(Boolean)
    .sort((a, b) => a - b);

  if (dates.length < minSessions) return false;

  const windowMs = Number(windowDays || 0) * 86400000;

  for (let i = 0; i < dates.length; i += 1) {
    let count = 1;
    for (let j = i + 1; j < dates.length; j += 1) {
      if (dates[j].getTime() - dates[i].getTime() <= windowMs) {
        count += 1;
        if (count >= minSessions) return true;
      } else {
        break;
      }
    }
  }

  return false;
}

function hasAtLeastNSessionsInSameWeek(reservations, minSessions) {
  const weekCounts = new Map();

  for (const row of reservations || []) {
    if (!qualifiesForGamification(row.status)) continue;
    const d = getValidReservationDate(row);
    if (!d) continue;

    const weekKey = getMondayKey(d);
    if (!weekKey) continue;

    weekCounts.set(weekKey, (weekCounts.get(weekKey) || 0) + 1);
  }

  for (const count of weekCounts.values()) {
    if (count >= minSessions) return true;
  }

  return false;
}

function hasConsecutiveWeeksWithMinSessions(
  reservations,
  consecutiveWeeks,
  minSessionsPerWeek
) {
  const weekCounts = new Map();

  for (const row of reservations || []) {
    if (!qualifiesForGamification(row.status)) continue;
    const d = getValidReservationDate(row);
    if (!d) continue;

    const weekKey = getMondayKey(d);
    if (!weekKey) continue;

    weekCounts.set(weekKey, (weekCounts.get(weekKey) || 0) + 1);
  }

  const qualifyingWeeks = [...weekCounts.entries()]
    .filter(([, count]) => count >= minSessionsPerWeek)
    .map(([weekKey]) => weekKey)
    .sort();

  if (qualifyingWeeks.length < consecutiveWeeks) return false;

  let run = 1;
  for (let i = 1; i < qualifyingWeeks.length; i += 1) {
    const gap = diffDaysUtc(qualifyingWeeks[i], qualifyingWeeks[i - 1]);
    if (gap === 7) {
      run += 1;
      if (run >= consecutiveWeeks) return true;
    } else {
      run = 1;
    }
  }

  return false;
}

async function ensureUserRows(userId) {
  if (!supabase || !userId) return;

  const nowIso = new Date().toISOString();

  const { error: gamifError } = await supabase
    .from("user_gamification")
    .upsert(
      {
        user_id: userId,
        updated_at: nowIso,
      },
      { onConflict: "user_id" }
    );

  if (gamifError) throw gamifError;

  const { error: statsError } = await supabase
    .from("user_stats")
    .upsert(
      {
        user_id: userId,
        updated_at: nowIso,
      },
      { onConflict: "user_id" }
    );

  if (statsError) throw statsError;
}

async function ensureBadgeDefinitions() {
  if (!supabase) return;

  const rows = [
    // COMMUNS — 5 singcoins
    {
      code: "first_session",
      title: "Première session",
      description: "Faire une première session réalisée",
      rarity: "common",
      icon: "sparkles",
      reward_singcoins: 5,
      reward_xp: 0,
      is_active: true,
      sort_order: 1,
    },
    {
      code: "group_3_plus",
      title: "Session en groupe",
      description: "Faire une session à 3 personnes ou plus",
      rarity: "common",
      icon: "users",
      reward_singcoins: 5,
      reward_xp: 0,
      is_active: true,
      sort_order: 2,
    },
    {
      code: "two_sessions",
      title: "2 sessions réalisées",
      description: "Faire 2 sessions réalisées",
      rarity: "common",
      icon: "mic",
      reward_singcoins: 5,
      reward_xp: 0,
      is_active: true,
      sort_order: 3,
    },

    // RARES — 10 singcoins
    {
      code: "three_week_streak",
      title: "3 semaines d’affilée",
      description: "Atteindre un streak de 3 semaines",
      rarity: "rare",
      icon: "flame",
      reward_singcoins: 10,
      reward_xp: 0,
      is_active: true,
      sort_order: 4,
    },
    {
      code: "group_5_plus",
      title: "Groupe de 5+",
      description: "Faire une session à 5 personnes ou plus",
      rarity: "rare",
      icon: "users",
      reward_singcoins: 10,
      reward_xp: 0,
      is_active: true,
      sort_order: 5,
    },
    {
      code: "five_sessions",
      title: "5 sessions réalisées",
      description: "Faire 5 sessions réalisées",
      rarity: "rare",
      icon: "calendar",
      reward_singcoins: 10,
      reward_xp: 0,
      is_active: true,
      sort_order: 6,
    },
    {
      code: "three_sessions_in_7_days",
      title: "3 sessions en 7 jours",
      description: "Faire 3 sessions réalisées sur 7 jours glissants",
      rarity: "rare",
      icon: "clock3",
      reward_singcoins: 10,
      reward_xp: 0,
      is_active: true,
      sort_order: 7,
    },

    // ÉPIQUES — 15 singcoins
    {
      code: "ten_sessions",
      title: "10 sessions réalisées",
      description: "Faire 10 sessions réalisées",
      rarity: "epic",
      icon: "rocket",
      reward_singcoins: 15,
      reward_xp: 0,
      is_active: true,
      sort_order: 8,
    },
    {
      code: "five_week_streak",
      title: "Streak de 5 semaines",
      description: "Atteindre un streak de 5 semaines",
      rarity: "epic",
      icon: "fire",
      reward_singcoins: 15,
      reward_xp: 0,
      is_active: true,
      sort_order: 9,
    },
    {
      code: "group_8_plus",
      title: "Groupe de 8+",
      description: "Faire une session à 8 personnes ou plus",
      rarity: "epic",
      icon: "target",
      reward_singcoins: 15,
      reward_xp: 0,
      is_active: true,
      sort_order: 10,
    },
    {
      code: "three_sessions_one_week",
      title: "3 sessions en 1 semaine",
      description: "Faire 3 sessions réalisées dans une même semaine",
      rarity: "epic",
      icon: "bolt",
      reward_singcoins: 15,
      reward_xp: 0,
      is_active: true,
      sort_order: 11,
    },

    // LÉGENDAIRES — 20 singcoins
    {
      code: "twenty_five_sessions",
      title: "25 sessions réalisées",
      description: "Faire 25 sessions réalisées",
      rarity: "legendary",
      icon: "crown",
      reward_singcoins: 20,
      reward_xp: 0,
      is_active: true,
      sort_order: 12,
    },
    {
      code: "ten_week_streak",
      title: "Streak de 10 semaines",
      description: "Atteindre un streak de 10 semaines",
      rarity: "legendary",
      icon: "star",
      reward_singcoins: 20,
      reward_xp: 0,
      is_active: true,
      sort_order: 13,
    },
    {
      code: "ten_group_sessions_5_plus",
      title: "10 sessions en groupe (5+)",
      description: "Faire 10 sessions à 5 personnes ou plus",
      rarity: "legendary",
      icon: "gem",
      reward_singcoins: 20,
      reward_xp: 0,
      is_active: true,
      sort_order: 14,
    },
    {
      code: "four_weeks_two_sessions_each",
      title: "4 semaines à 2 sessions",
      description:
        "Faire 4 semaines consécutives avec au moins 2 sessions par semaine",
      rarity: "legendary",
      icon: "trophy",
      reward_singcoins: 20,
      reward_xp: 0,
      is_active: true,
      sort_order: 15,
    },
  ];

  const { error } = await supabase
    .from("badge_definitions")
    .upsert(rows, { onConflict: "code" });

  if (error) throw error;
}

async function ensureMissionDefinitions() {
  if (!supabase) return;

  const rows = [
    {
      code: "book_once_week",
      title: "Une session cette semaine",
      description: "Faire au moins 1 session réalisée cette semaine",
      target_value: 1,
      reward_singcoins: 5,
      reward_xp: 10,
      is_active: true,
      sort_order: 1,
    },
    {
      code: "come_with_3_people",
      title: "Venir en groupe",
      description: "Faire une session avec 3 personnes ou plus cette semaine",
      target_value: 1,
      reward_singcoins: 5,
      reward_xp: 10,
      is_active: true,
      sort_order: 2,
    },
    {
      code: "weekday_booking",
      title: "Créneau semaine",
      description: "Faire une session hors week-end cette semaine",
      target_value: 1,
      reward_singcoins: 10,
      reward_xp: 10,
      is_active: true,
      sort_order: 3,
    },
  ];

  const { error } = await supabase
    .from("weekly_missions")
    .upsert(rows, { onConflict: "code" });

  if (error) throw error;
}

async function sumLedger(table, userId) {
  const { data, error } = await supabase
    .from(table)
    .select("amount")
    .eq("user_id", userId);

  if (error) throw error;

  const amounts = (data || []).map((row) => Number(row.amount || 0));
  const positiveAmounts = amounts.filter((v) => v > 0);
  const negativeAmounts = amounts.filter((v) => v < 0);

  return {
    positive: positiveAmounts.reduce((a, b) => a + b, 0),
    negativeAbs: Math.abs(negativeAmounts.reduce((a, b) => a + b, 0)),
    negativeCount: negativeAmounts.length,
    balance: amounts.reduce((a, b) => a + b, 0),
  };
}

async function refreshGamificationSummary(userId) {
  await ensureUserRows(userId);

  const singcoins = await sumLedger("singcoin_ledger", userId);
  const xpLedger = await sumLedger("xp_ledger", userId);
  const level = computeLevel(xpLedger.balance);

  const { error } = await supabase
    .from("user_gamification")
    .update({
      singcoins_balance: singcoins.balance,
      singcoins_earned_total: singcoins.positive,
      singcoins_used_total: singcoins.negativeAbs,
      xp_total: xpLedger.balance,
      level_current: level.level,
      level_name: level.name,
      updated_at: new Date().toISOString(),
    })
    .eq("user_id", userId);

  if (error) throw error;

  const { data, error: readError } = await supabase
    .from("user_gamification")
    .select("*")
    .eq("user_id", userId)
    .maybeSingle();

  if (readError) throw readError;

  return data;
}

async function creditLedger({
  table,
  userId,
  amount,
  type,
  referenceType = null,
  referenceId = null,
  label = null,
}) {
  if (!supabase || !userId || !amount) {
    return { skipped: true };
  }

  const payload = {
    user_id: userId,
    amount,
    type,
    reference_type: referenceType,
    reference_id: referenceId ? String(referenceId) : null,
    label,
  };

  const { error } = await supabase.from(table).insert(payload);

  if (error) {
    if (String(error.code || "") === "23505") {
      return { duplicate: true };
    }
    throw error;
  }

  return { inserted: true };
}

async function insertGamificationEvent({
  userId,
  eventType,
  referenceType = null,
  referenceId = null,
  payload = {},
  processed = true,
}) {
  if (!supabase || !userId || !eventType) {
    return { skipped: true };
  }

  const safeReferenceId = referenceId ? String(referenceId) : null;

  if (referenceType && safeReferenceId) {
    const { data: existing, error: existingError } = await supabase
      .from("gamification_events")
      .select("id, processed")
      .eq("event_type", eventType)
      .eq("reference_type", referenceType)
      .eq("reference_id", safeReferenceId)
      .maybeSingle();

    if (existingError) throw existingError;

    if (existing) {
      return {
        duplicate: true,
        existing,
      };
    }
  }

  const nowIso = new Date().toISOString();

  const { data, error } = await supabase
    .from("gamification_events")
    .insert({
      user_id: userId,
      event_type: eventType,
      reference_type: referenceType,
      reference_id: safeReferenceId,
      payload: payload || {},
      processed,
      processed_at: processed ? nowIso : null,
      created_at: nowIso,
    })
    .select("id")
    .single();

  if (error) {
    if (String(error.code || "") === "23505") {
      return { duplicate: true };
    }
    throw error;
  }

  return {
    inserted: true,
    id: data?.id || null,
  };
}

export async function createGamificationEvent({
  user_id,
  event_type,
  reference_type = null,
  reference_id = null,
  payload = {},
  processed = false,
}) {
  return insertGamificationEvent({
    userId: user_id,
    eventType: event_type,
    referenceType: reference_type,
    referenceId: reference_id,
    payload,
    processed,
  });
}

export async function creditSingcoins({
  userId,
  amount,
  type,
  referenceType = null,
  referenceId = null,
  label = null,
}) {
  const result = await creditLedger({
    table: "singcoin_ledger",
    userId,
    amount,
    type,
    referenceType,
    referenceId,
    label,
  });

  await refreshGamificationSummary(userId);
  return result;
}

export async function creditXp({
  userId,
  amount,
  type,
  referenceType = null,
  referenceId = null,
  label = null,
}) {
  const result = await creditLedger({
    table: "xp_ledger",
    userId,
    amount,
    type,
    referenceType,
    referenceId,
    label,
  });

  await refreshGamificationSummary(userId);
  return result;
}

export async function getAvailableSingcoinsForUser(userId) {
  if (!supabase || !userId) return 0;

  await ensureUserRows(userId);

  const { data, error } = await supabase
    .from("user_gamification")
    .select("singcoins_balance")
    .eq("user_id", userId)
    .maybeSingle();

  if (error) throw error;

  return Math.max(0, Number(data?.singcoins_balance || 0));
}

export async function debitSingcoins({
  userId,
  amount,
  type = "manual_spend",
  referenceType = null,
  referenceId = null,
  label = null,
}) {
  const spendAmount = Math.max(0, Number(amount || 0));

  if (!supabase) throw new Error("Supabase non configuré");
  if (!userId) throw new Error("userId manquant");

  if (!spendAmount) {
    return {
      success: true,
      deducted: 0,
      remainingSingcoins: await getAvailableSingcoinsForUser(userId),
    };
  }

  const currentBalance = await getAvailableSingcoinsForUser(userId);

  if (currentBalance < spendAmount) {
    return {
      success: false,
      reason: "Pas assez de Singcoins",
      currentSingcoins: currentBalance,
      requiredSingcoins: spendAmount,
    };
  }

  await creditSingcoins({
    userId,
    amount: -spendAmount,
    type,
    referenceType,
    referenceId,
    label,
  });

  const remainingSingcoins = await getAvailableSingcoinsForUser(userId);

  return {
    success: true,
    deducted: spendAmount,
    remainingSingcoins,
  };
}

export async function refundSingcoins({
  userId,
  amount,
  type = "manual_refund",
  referenceType = null,
  referenceId = null,
  label = null,
}) {
  const refundAmount = Math.max(0, Number(amount || 0));

  if (!supabase) throw new Error("Supabase non configuré");

  if (!userId || !refundAmount) {
    return {
      success: true,
      refunded: 0,
      balance: userId ? await getAvailableSingcoinsForUser(userId) : 0,
    };
  }

  await creditSingcoins({
    userId,
    amount: refundAmount,
    type,
    referenceType,
    referenceId,
    label,
  });

  const balance = await getAvailableSingcoinsForUser(userId);

  return {
    success: true,
    refunded: refundAmount,
    balance,
  };
}

async function syncUserStats(userId) {
  await ensureUserRows(userId);

  const { data: reservations, error } = await supabase
    .from("reservations")
    .select(`
      id,
      status,
      start_time,
      end_time,
      persons,
      is_weekend,
      is_daytime,
      is_group_session,
      session_minutes,
      checked_in_at,
      completed_at,
      cancelled_at,
      refunded_at
    `)
    .eq("user_id", userId);

  if (error) throw error;

  const rows = reservations || [];
  const completed = rows.filter((row) => qualifiesForGamification(row.status));
  const cancelled = rows.filter((row) =>
    CANCELLED_STATUSES.includes(normalizeStatus(row.status))
  );

  const now = Date.now();
  const last7 = now - 7 * 86400000;
  const last30 = now - 30 * 86400000;

  const minutesTotal = completed.reduce(
    (sum, row) => sum + Math.max(0, Number(row.session_minutes || 0)),
    0
  );

  const largestGroup = completed.reduce(
    (max, row) => Math.max(max, Number(row.persons || 0)),
    0
  );

  const longestSession = completed.reduce(
    (max, row) => Math.max(max, Number(row.session_minutes || 0)),
    0
  );

  const starts = completed
    .map((row) => row.completed_at || row.start_time)
    .filter(Boolean)
    .map((v) => new Date(v))
    .filter((d) => !Number.isNaN(d.getTime()))
    .sort((a, b) => a - b);

  const sessionsLast7 = completed.filter((row) => {
    const t = new Date(row.completed_at || row.start_time || 0).getTime();
    return !Number.isNaN(t) && t >= last7;
  }).length;

  const sessionsLast30 = completed.filter((row) => {
    const t = new Date(row.completed_at || row.start_time || 0).getTime();
    return !Number.isNaN(t) && t >= last30;
  }).length;

  const spentLedger = await sumLedger("singcoin_ledger", userId);

  const payload = {
    user_id: userId,
    sessions_total: rows.length,
    sessions_completed: completed.length,
    sessions_cancelled: cancelled.length,
    group_sessions_total: completed.filter(
      (row) => !!row.is_group_session || Number(row.persons || 0) >= 3
    ).length,
    sessions_daytime_total: completed.filter((row) => !!row.is_daytime).length,
    sessions_weekday_total: completed.filter((row) => !row.is_weekend).length,
    sessions_weekend_total: completed.filter((row) => !!row.is_weekend).length,
    sessions_last_7_days: sessionsLast7,
    sessions_last_30_days: sessionsLast30,
    songs_total: 0,
    minutes_sung_total: minutesTotal,
    hours_sung_total: Number((minutesTotal / 60).toFixed(2)),
    largest_group_size: largestGroup,
    longest_session_minutes: longestSession,
    first_session_at: starts[0]?.toISOString() || null,
    last_session_at: starts[starts.length - 1]?.toISOString() || null,
    singcoins_spent_count: spentLedger.negativeCount,
    singcoins_spent_total: spentLedger.negativeAbs,
    updated_at: new Date().toISOString(),
  };

  const { error: upsertError } = await supabase
    .from("user_stats")
    .upsert(payload, { onConflict: "user_id" });

  if (upsertError) throw upsertError;
}

async function syncStreak(userId) {
  const { data: reservations, error } = await supabase
    .from("reservations")
    .select("completed_at,start_time,status")
    .eq("user_id", userId);

  if (error) throw error;

  const weekKeys = (reservations || [])
    .filter((row) => qualifiesForGamification(row.status))
    .map((row) => getMondayKey(row.completed_at || row.start_time))
    .filter(Boolean);

  const streak = buildStreakFromWeekKeys(weekKeys);

  const { error: updateError } = await supabase
    .from("user_gamification")
    .update({
      streak_current: streak.current,
      streak_best: streak.best,
      streak_last_period_key: streak.lastKey,
      streak_last_validated_at: streak.lastKey
        ? `${streak.lastKey}T00:00:00.000Z`
        : null,
      updated_at: new Date().toISOString(),
    })
    .eq("user_id", userId);

  if (updateError) throw updateError;
}

async function syncWeeklyMissions(userId) {
  await ensureMissionDefinitions();

  const now = new Date();
  const currentWeekStart = getMondayKey(now);

  if (!currentWeekStart) return;

  const weekStartTs = new Date(`${currentWeekStart}T00:00:00.000Z`).getTime();
  const weekEndTs = weekStartTs + 7 * 86400000;

  const [
    { data: missions, error: missionsError },
    { data: reservations, error: reservationsError },
  ] = await Promise.all([
    supabase
      .from("weekly_missions")
      .select("*")
      .eq("is_active", true)
      .order("sort_order"),
    supabase
      .from("reservations")
      .select("id,completed_at,start_time,status,persons,is_weekend")
      .eq("user_id", userId),
  ]);

  if (missionsError) throw missionsError;
  if (reservationsError) throw reservationsError;

  const weekReservations = (reservations || []).filter((row) => {
    if (!qualifiesForGamification(row.status)) return false;
    const t = new Date(row.completed_at || row.start_time || 0).getTime();
    return !Number.isNaN(t) && t >= weekStartTs && t < weekEndTs;
  });

  for (const mission of missions || []) {
    let progressValue = 0;

    if (mission.code === "book_once_week") {
      progressValue = Math.min(1, weekReservations.length);
    } else if (mission.code === "come_with_3_people") {
      progressValue = weekReservations.some((row) => Number(row.persons || 0) >= 3)
        ? 1
        : 0;
    } else if (mission.code === "weekday_booking") {
      progressValue = weekReservations.some((row) => !row.is_weekend) ? 1 : 0;
    }

    const targetValue = Number(mission.target_value || 1);
    const isCompleted = progressValue >= targetValue;

    const { data: existing, error: existingError } = await supabase
      .from("user_mission_progress")
      .select("*")
      .eq("user_id", userId)
      .eq("mission_code", mission.code)
      .eq("week_start", currentWeekStart)
      .maybeSingle();

    if (existingError) throw existingError;

    if (!existing) {
      const { error: insertError } = await supabase
        .from("user_mission_progress")
        .insert({
          user_id: userId,
          mission_code: mission.code,
          week_start: currentWeekStart,
          progress_value: progressValue,
          target_value: targetValue,
          is_completed: isCompleted,
          completed_at: isCompleted ? new Date().toISOString() : null,
          reward_claimed: false,
          updated_at: new Date().toISOString(),
        });

      if (insertError) throw insertError;
    } else {
      const { error: updateError } = await supabase
        .from("user_mission_progress")
        .update({
          progress_value: progressValue,
          target_value: targetValue,
          is_completed: isCompleted,
          completed_at: isCompleted
            ? existing.completed_at || new Date().toISOString()
            : null,
          updated_at: new Date().toISOString(),
        })
        .eq("id", existing.id);

      if (updateError) throw updateError;
    }

    const { data: refreshed, error: refreshedError } = await supabase
      .from("user_mission_progress")
      .select("*")
      .eq("user_id", userId)
      .eq("mission_code", mission.code)
      .eq("week_start", currentWeekStart)
      .maybeSingle();

    if (refreshedError) throw refreshedError;

    if (refreshed?.is_completed && !refreshed.reward_claimed) {
      const referenceId = `${mission.code}:${currentWeekStart}`;

      await creditSingcoins({
        userId,
        amount: Number(mission.reward_singcoins || 0),
        type: "mission_reward",
        referenceType: "mission",
        referenceId,
        label: mission.title,
      });

      await creditXp({
        userId,
        amount: Number(mission.reward_xp || 0),
        type: "mission_reward",
        referenceType: "mission",
        referenceId,
        label: mission.title,
      });

      const { error: claimedError } = await supabase
        .from("user_mission_progress")
        .update({
          reward_claimed: true,
          updated_at: new Date().toISOString(),
        })
        .eq("id", refreshed.id);

      if (claimedError) throw claimedError;
    }
  }
}

function isBadgeUnlocked(def, stats, gamification, reservations) {
  const completedSessions = Number(stats?.sessions_completed || 0);
  const bestStreak = Number(gamification?.streak_best || 0);

  if (def.code === "first_session") {
    return completedSessions >= 1;
  }

  if (def.code === "group_3_plus") {
    return Number(stats?.largest_group_size || 0) >= 3;
  }

  if (def.code === "two_sessions") {
    return completedSessions >= 2;
  }

  if (def.code === "three_week_streak") {
    return bestStreak >= 3;
  }

  if (def.code === "group_5_plus") {
    return Number(stats?.largest_group_size || 0) >= 5;
  }

  if (def.code === "five_sessions") {
    return completedSessions >= 5;
  }

  if (def.code === "three_sessions_in_7_days") {
    return hasAtLeastNSessionsInRollingDays(reservations, 3, 7);
  }

  if (def.code === "ten_sessions") {
    return completedSessions >= 10;
  }

  if (def.code === "five_week_streak") {
    return bestStreak >= 5;
  }

  if (def.code === "group_8_plus") {
    return Number(stats?.largest_group_size || 0) >= 8;
  }

  if (def.code === "three_sessions_one_week") {
    return hasAtLeastNSessionsInSameWeek(reservations, 3);
  }

  if (def.code === "twenty_five_sessions") {
    return completedSessions >= 25;
  }

  if (def.code === "ten_week_streak") {
    return bestStreak >= 10;
  }

  if (def.code === "ten_group_sessions_5_plus") {
    return countGroupSessions(reservations, 5) >= 10;
  }

  if (def.code === "four_weeks_two_sessions_each") {
    return hasConsecutiveWeeksWithMinSessions(reservations, 4, 2);
  }

  return false;
}

async function evaluateBadges(userId) {
  await ensureBadgeDefinitions();

  const [
    { data: defs, error: defsError },
    { data: unlocked, error: unlockedError },
    { data: stats, error: statsError },
    { data: gamification, error: gamificationError },
    { data: reservations, error: reservationsError },
  ] = await Promise.all([
    supabase
      .from("badge_definitions")
      .select("*")
      .eq("is_active", true)
      .order("sort_order"),
    supabase
      .from("user_badges")
      .select("badge_code")
      .eq("user_id", userId),
    supabase
      .from("user_stats")
      .select("*")
      .eq("user_id", userId)
      .maybeSingle(),
    supabase
      .from("user_gamification")
      .select("*")
      .eq("user_id", userId)
      .maybeSingle(),
    supabase
      .from("reservations")
      .select("id,status,start_time,completed_at,persons")
      .eq("user_id", userId),
  ]);

  if (defsError) throw defsError;
  if (unlockedError) throw unlockedError;
  if (statsError) throw statsError;
  if (gamificationError) throw gamificationError;
  if (reservationsError) throw reservationsError;

  const unlockedCodes = new Set((unlocked || []).map((row) => row.badge_code));

  for (const def of defs || []) {
    if (unlockedCodes.has(def.code)) continue;

    const unlockedNow = isBadgeUnlocked(def, stats, gamification, reservations || []);
    if (!unlockedNow) continue;

    const { error: insertError } = await supabase
      .from("user_badges")
      .insert({
        user_id: userId,
        badge_code: def.code,
        unlocked_at: new Date().toISOString(),
        reward_singcoins: Number(def.reward_singcoins || 0),
        reward_xp: Number(def.reward_xp || 0),
        source_event_id: def.code,
      });

    if (insertError) {
      if (String(insertError.code || "") !== "23505") {
        throw insertError;
      }
    } else {
      await creditSingcoins({
        userId,
        amount: Number(def.reward_singcoins || 0),
        type: "badge_reward",
        referenceType: "badge",
        referenceId: def.code,
        label: def.title,
      });

      if (Number(def.reward_xp || 0) > 0) {
        await creditXp({
          userId,
          amount: Number(def.reward_xp || 0),
          type: "badge_reward",
          referenceType: "badge",
          referenceId: def.code,
          label: def.title,
        });
      }
    }
  }
}

async function syncGamificationForUser(userId) {
  if (!supabase || !userId) return;

  await ensureUserRows(userId);
  await ensureMissionDefinitions();
  await ensureBadgeDefinitions();
  await syncUserStats(userId);
  await syncStreak(userId);
  await syncWeeklyMissions(userId);
  await refreshGamificationSummary(userId);
  await evaluateBadges(userId);
  await syncUserStats(userId);
  await refreshGamificationSummary(userId);
}

export async function processReservationGamification(reservationId) {
  if (!supabase || !reservationId) return null;

  const { data: reservation, error } = await supabase
    .from("reservations")
    .select("*")
    .eq("id", reservationId)
    .maybeSingle();

  if (error) throw error;
  if (!reservation) return null;
  if (!reservation.user_id) return null;
  if (!qualifiesForGamification(reservation.status)) return null;

  const userId = reservation.user_id;

  await ensureUserRows(userId);

  const eventResult = await insertGamificationEvent({
    userId,
    eventType: "reservation_completed",
    referenceType: "reservation",
    referenceId: reservation.id,
    payload: {
      reservation_id: reservation.id,
      status: reservation.status,
      start_time: reservation.start_time,
      end_time: reservation.end_time,
      completed_at: reservation.completed_at,
      persons: reservation.persons,
      is_weekend: reservation.is_weekend,
      is_daytime: reservation.is_daytime,
      is_group_session: reservation.is_group_session,
      session_minutes: reservation.session_minutes,
    },
    processed: true,
  });

  if (!eventResult.duplicate) {
    await creditSingcoins({
      userId,
      amount: BASE_RESERVATION_SINGCOINS,
      type: "reservation_reward",
      referenceType: "reservation",
      referenceId: String(reservation.id),
      label: "Session réalisée",
    });

    await creditXp({
      userId,
      amount: BASE_RESERVATION_XP,
      type: "reservation_reward",
      referenceType: "reservation",
      referenceId: String(reservation.id),
      label: "Session réalisée",
    });
  }

  await syncGamificationForUser(userId);

  return getUserGamificationSnapshot(userId);
}

export async function getUserGamificationSnapshot(userId) {
  if (!supabase || !userId) {
    return {
      singcoins: { balance: 0, earned: 0, used: 0 },
      level: {
        current: 1,
        name: "Nouveau",
        xpCurrent: 0,
        xpNextLevel: 100,
        xpTotal: 0,
      },
      streak: {
        current: 0,
        best: 0,
        jokers: 0,
        lastValidatedAt: null,
        lastPeriodKey: null,
      },
      stats: {
        totalSessions: 0,
        totalTime: "0h",
        totalSongs: 0,
        lastSession: null,
        sessionsLast7Days: 0,
        sessionsLast30Days: 0,
      },
      records: {
        bestStreak: 0,
        biggestSession: 0,
        longestSessionMinutes: 0,
      },
      missions: [],
      badges: [],
    };
  }

  await syncGamificationForUser(userId);

  const [
    { data: gamification, error: gamificationError },
    { data: stats, error: statsError },
    { data: badgeDefs, error: badgeDefsError },
    { data: userBadges, error: userBadgesError },
    { data: missionDefs, error: missionDefsError },
    { data: missionProgress, error: missionProgressError },
  ] = await Promise.all([
    supabase
      .from("user_gamification")
      .select("*")
      .eq("user_id", userId)
      .maybeSingle(),
    supabase
      .from("user_stats")
      .select("*")
      .eq("user_id", userId)
      .maybeSingle(),
    supabase
      .from("badge_definitions")
      .select("*")
      .eq("is_active", true)
      .order("sort_order"),
    supabase
      .from("user_badges")
      .select("*")
      .eq("user_id", userId),
    supabase
      .from("weekly_missions")
      .select("*")
      .eq("is_active", true)
      .order("sort_order"),
    supabase
      .from("user_mission_progress")
      .select("*")
      .eq("user_id", userId),
  ]);

  if (gamificationError) throw gamificationError;
  if (statsError) throw statsError;
  if (badgeDefsError) throw badgeDefsError;
  if (userBadgesError) throw userBadgesError;
  if (missionDefsError) throw missionDefsError;
  if (missionProgressError) throw missionProgressError;

  const xp = Number(gamification?.xp_total || 0);
  const level = computeLevel(xp);
  const currentWeek = getMondayKey(new Date());

  const userBadgeMap = new Map((userBadges || []).map((row) => [row.badge_code, row]));
  const missionByKey = new Map(
    (missionProgress || []).map((row) => [`${row.mission_code}:${row.week_start}`, row])
  );

  const badges = (badgeDefs || [])
    .map((def) => {
      const unlocked = userBadgeMap.get(def.code) || null;

      return {
        code: def.code,
        title: def.title,
        description: def.description,
        desc: def.description,
        rarity: def.rarity || "common",
        icon: mapBadgeIcon(def.icon),
        sortOrder: Number(def.sort_order || 999),
        rewardSingcoins: Number(
          unlocked?.reward_singcoins ?? def.reward_singcoins ?? 0
        ),
        rewardXp: Number(unlocked?.reward_xp ?? def.reward_xp ?? 0),
        isUnlocked: !!unlocked,
        unlockedAt: unlocked?.unlocked_at || null,
      };
    })
    .sort((a, b) => Number(a.sortOrder || 0) - Number(b.sortOrder || 0));

  const missions = (missionDefs || []).map((def) => {
    const progress = missionByKey.get(`${def.code}:${currentWeek}`) || null;

    return {
      code: def.code,
      title: def.title,
      description: def.description,
      targetValue: Number(def.target_value || 1),
      rewardSingcoins: Number(def.reward_singcoins || 0),
      rewardXp: Number(def.reward_xp || 0),
      weekStart: currentWeek,
      progressValue: Number(progress?.progress_value || 0),
      isCompleted: !!progress?.is_completed,
      rewardClaimed: !!progress?.reward_claimed,
      completedAt: progress?.completed_at || null,
    };
  });

  return {
    singcoins: {
      balance: Number(gamification?.singcoins_balance || 0),
      earned: Number(gamification?.singcoins_earned_total || 0),
      used: Number(gamification?.singcoins_used_total || 0),
    },
    level: {
      current: level.level,
      name: gamification?.level_name || level.name,
      xpCurrent: level.xpCurrent,
      xpNextLevel: level.xpNext,
      xpTotal: xp,
    },
    streak: {
      current: Number(gamification?.streak_current || 0),
      best: Number(gamification?.streak_best || 0),
      jokers: Number(gamification?.jokers_available || 0),
      lastValidatedAt: gamification?.streak_last_validated_at || null,
      lastPeriodKey: gamification?.streak_last_period_key || null,
    },
    stats: {
      totalSessions: Number(stats?.sessions_completed || 0),
      totalTime: formatHoursFromMinutes(stats?.minutes_sung_total || 0),
      totalSongs: Number(stats?.songs_total || 0),
      lastSession: toIsoDate(stats?.last_session_at),
      sessionsLast7Days: Number(stats?.sessions_last_7_days || 0),
      sessionsLast30Days: Number(stats?.sessions_last_30_days || 0),
    },
    records: {
      bestStreak: Number(gamification?.streak_best || 0),
      biggestSession: Number(stats?.largest_group_size || 0),
      longestSessionMinutes: Number(stats?.longest_session_minutes || 0),
    },
    missions,
    badges,
  };
}