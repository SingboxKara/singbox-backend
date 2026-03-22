import { supabase } from "../config/supabase.js";

const QUALIFYING_STATUSES = ["confirmed", "checked_in", "completed"];
const CANCELLED_STATUSES = ["cancelled", "annulee", "annulée", "refunded", "remboursee", "remboursée"];

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

async function ensureUserRows(userId) {
  if (!supabase || !userId) return;

  await supabase
    .from("user_gamification")
    .upsert(
      {
        user_id: userId,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "user_id" }
    );

  await supabase
    .from("user_stats")
    .upsert(
      {
        user_id: userId,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "user_id" }
    );
}

async function ensureBadgeDefinitions() {
  if (!supabase) return;

  const rows = [
    {
      code: "first_session",
      title: "Première session",
      description: "Faire une première réservation",
      rarity: "common",
      icon: "sparkles",
      reward_singcoins: 5,
      reward_xp: 10,
      is_active: true,
      sort_order: 1,
    },
    {
      code: "two_sessions",
      title: "Ça repart",
      description: "Faire 2 sessions",
      rarity: "common",
      icon: "mic",
      reward_singcoins: 5,
      reward_xp: 10,
      is_active: true,
      sort_order: 2,
    },
    {
      code: "three_hours",
      title: "3h de chant",
      description: "Atteindre 3 heures cumulées",
      rarity: "common",
      icon: "clock3",
      reward_singcoins: 10,
      reward_xp: 15,
      is_active: true,
      sort_order: 3,
    },
    {
      code: "weekday_regular",
      title: "Habitué de semaine",
      description: "Faire 3 sessions hors week-end",
      rarity: "rare",
      icon: "calendar",
      reward_singcoins: 10,
      reward_xp: 20,
      is_active: true,
      sort_order: 4,
    },
    {
      code: "group_vibes",
      title: "Chef de bande",
      description: "Faire une session à 3 personnes ou plus",
      rarity: "rare",
      icon: "users",
      reward_singcoins: 10,
      reward_xp: 20,
      is_active: true,
      sort_order: 5,
    },
    {
      code: "ten_sessions",
      title: "Habitué confirmé",
      description: "Faire 10 sessions",
      rarity: "epic",
      icon: "trophy",
      reward_singcoins: 20,
      reward_xp: 30,
      is_active: true,
      sort_order: 6,
    },
    {
      code: "four_week_streak",
      title: "Toujours là",
      description: "Tenir 4 semaines d'affilée",
      rarity: "epic",
      icon: "flame",
      reward_singcoins: 20,
      reward_xp: 30,
      is_active: true,
      sort_order: 7,
    },
    {
      code: "spent_singcoins_once",
      title: "Premier échange",
      description: "Utiliser des Singcoins une fois",
      rarity: "rare",
      icon: "gift",
      reward_singcoins: 5,
      reward_xp: 10,
      is_active: true,
      sort_order: 8,
    },
  ];

  await supabase.from("badge_definitions").upsert(rows, { onConflict: "code" });
}

async function ensureMissionDefinitions() {
  if (!supabase) return;

  const rows = [
    {
      code: "book_once_week",
      title: "Une session cette semaine",
      description: "Faire au moins 1 réservation cette semaine",
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
      reward_singcoins: 8,
      reward_xp: 12,
      is_active: true,
      sort_order: 2,
    },
    {
      code: "weekday_booking",
      title: "Créneau semaine",
      description: "Faire une session hors week-end cette semaine",
      target_value: 1,
      reward_singcoins: 6,
      reward_xp: 10,
      is_active: true,
      sort_order: 3,
    },
  ];

  await supabase.from("weekly_missions").upsert(rows, { onConflict: "code" });
}

async function sumLedger(table, userId) {
  const { data, error } = await supabase
    .from(table)
    .select("amount")
    .eq("user_id", userId);

  if (error) throw error;

  const amounts = (data || []).map((row) => Number(row.amount || 0));
  return {
    positive: amounts.filter((v) => v > 0).reduce((a, b) => a + b, 0),
    negativeAbs: Math.abs(amounts.filter((v) => v < 0).reduce((a, b) => a + b, 0)),
    balance: amounts.reduce((a, b) => a + b, 0),
  };
}

async function refreshGamificationSummary(userId) {
  await ensureUserRows(userId);

  const singcoins = await sumLedger("singcoin_ledger", userId);
  const xpLedger = await sumLedger("xp_ledger", userId);
  const level = computeLevel(xpLedger.balance);

  await supabase
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

  const { data } = await supabase
    .from("user_gamification")
    .select("*")
    .eq("user_id", userId)
    .maybeSingle();

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
  if (!supabase || !userId || !amount) return { skipped: true };

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

async function creditSingcoins({
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

async function creditXp({
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
  const active = rows.filter((row) => qualifiesForGamification(row.status));
  const cancelled = rows.filter((row) => CANCELLED_STATUSES.includes(normalizeStatus(row.status)));

  const now = Date.now();
  const last7 = now - 7 * 86400000;
  const last30 = now - 30 * 86400000;

  const minutesTotal = active.reduce(
    (sum, row) => sum + Math.max(0, Number(row.session_minutes || 0)),
    0
  );

  const largestGroup = active.reduce(
    (max, row) => Math.max(max, Number(row.persons || 0)),
    0
  );

  const longestSession = active.reduce(
    (max, row) => Math.max(max, Number(row.session_minutes || 0)),
    0
  );

  const starts = active
    .map((row) => row.start_time)
    .filter(Boolean)
    .map((v) => new Date(v))
    .filter((d) => !Number.isNaN(d.getTime()))
    .sort((a, b) => a - b);

  const sessionsLast7 = active.filter((row) => {
    const t = new Date(row.start_time || row.completed_at || row.checked_in_at || 0).getTime();
    return !Number.isNaN(t) && t >= last7;
  }).length;

  const sessionsLast30 = active.filter((row) => {
    const t = new Date(row.start_time || row.completed_at || row.checked_in_at || 0).getTime();
    return !Number.isNaN(t) && t >= last30;
  }).length;

  const spentLedger = await sumLedger("singcoin_ledger", userId);

  const payload = {
    user_id: userId,
    sessions_total: rows.length,
    sessions_completed: active.length,
    sessions_cancelled: cancelled.length,
    group_sessions_total: active.filter((row) => !!row.is_group_session || Number(row.persons || 0) >= 3).length,
    sessions_daytime_total: active.filter((row) => !!row.is_daytime).length,
    sessions_weekday_total: active.filter((row) => !row.is_weekend).length,
    sessions_weekend_total: active.filter((row) => !!row.is_weekend).length,
    sessions_last_7_days: sessionsLast7,
    sessions_last_30_days: sessionsLast30,
    songs_total: 0,
    minutes_sung_total: minutesTotal,
    hours_sung_total: Number((minutesTotal / 60).toFixed(2)),
    largest_group_size: largestGroup,
    longest_session_minutes: longestSession,
    first_session_at: starts[0]?.toISOString() || null,
    last_session_at: starts[starts.length - 1]?.toISOString() || null,
    singcoins_spent_count: spentLedger.negativeAbs > 0 ? 1 : 0,
    singcoins_spent_total: spentLedger.negativeAbs,
    updated_at: new Date().toISOString(),
  };

  await supabase.from("user_stats").upsert(payload, { onConflict: "user_id" });
}

async function syncStreak(userId) {
  const { data: reservations, error } = await supabase
    .from("reservations")
    .select("start_time,status")
    .eq("user_id", userId);

  if (error) throw error;

  const weekKeys = (reservations || [])
    .filter((row) => qualifiesForGamification(row.status))
    .map((row) => getMondayKey(row.start_time))
    .filter(Boolean);

  const streak = buildStreakFromWeekKeys(weekKeys);

  await supabase
    .from("user_gamification")
    .update({
      streak_current: streak.current,
      streak_best: streak.best,
      streak_last_period_key: streak.lastKey,
      streak_last_validated_at: streak.lastKey ? `${streak.lastKey}T00:00:00.000Z` : null,
      updated_at: new Date().toISOString(),
    })
    .eq("user_id", userId);
}

async function syncWeeklyMissions(userId) {
  await ensureMissionDefinitions();

  const now = new Date();
  const currentWeekStart = getMondayKey(now);
  if (!currentWeekStart) return;

  const weekStartTs = new Date(`${currentWeekStart}T00:00:00.000Z`).getTime();
  const weekEndTs = weekStartTs + 7 * 86400000;

  const [{ data: missions, error: missionsError }, { data: reservations, error: reservationsError }] =
    await Promise.all([
      supabase.from("weekly_missions").select("*").eq("is_active", true).order("sort_order"),
      supabase
        .from("reservations")
        .select("id,start_time,status,persons,is_weekend")
        .eq("user_id", userId),
    ]);

  if (missionsError) throw missionsError;
  if (reservationsError) throw reservationsError;

  const weekReservations = (reservations || []).filter((row) => {
    if (!qualifiesForGamification(row.status)) return false;
    const t = new Date(row.start_time || 0).getTime();
    return !Number.isNaN(t) && t >= weekStartTs && t < weekEndTs;
  });

  for (const mission of missions || []) {
    let progressValue = 0;

    if (mission.code === "book_once_week") {
      progressValue = Math.min(1, weekReservations.length);
    } else if (mission.code === "come_with_3_people") {
      progressValue = weekReservations.some((row) => Number(row.persons || 0) >= 3) ? 1 : 0;
    } else if (mission.code === "weekday_booking") {
      progressValue = weekReservations.some((row) => !row.is_weekend) ? 1 : 0;
    }

    const targetValue = Number(mission.target_value || 1);
    const isCompleted = progressValue >= targetValue;

    const { data: existing } = await supabase
      .from("user_mission_progress")
      .select("*")
      .eq("user_id", userId)
      .eq("mission_code", mission.code)
      .eq("week_start", currentWeekStart)
      .maybeSingle();

    if (!existing) {
      await supabase.from("user_mission_progress").insert({
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
    } else {
      await supabase
        .from("user_mission_progress")
        .update({
          progress_value: progressValue,
          target_value: targetValue,
          is_completed: isCompleted,
          completed_at: isCompleted ? existing.completed_at || new Date().toISOString() : null,
          updated_at: new Date().toISOString(),
        })
        .eq("id", existing.id);
    }

    const { data: refreshed } = await supabase
      .from("user_mission_progress")
      .select("*")
      .eq("user_id", userId)
      .eq("mission_code", mission.code)
      .eq("week_start", currentWeekStart)
      .maybeSingle();

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

      await supabase
        .from("user_mission_progress")
        .update({
          reward_claimed: true,
          updated_at: new Date().toISOString(),
        })
        .eq("id", refreshed.id);
    }
  }
}

async function evaluateBadges(userId) {
  await ensureBadgeDefinitions();

  const [{ data: defs, error: defsError }, { data: unlocked, error: unlockedError }, { data: stats, error: statsError }, { data: gamification, error: gamificationError }] =
    await Promise.all([
      supabase.from("badge_definitions").select("*").eq("is_active", true).order("sort_order"),
      supabase.from("user_badges").select("badge_code").eq("user_id", userId),
      supabase.from("user_stats").select("*").eq("user_id", userId).maybeSingle(),
      supabase.from("user_gamification").select("*").eq("user_id", userId).maybeSingle(),
    ]);

  if (defsError) throw defsError;
  if (unlockedError) throw unlockedError;
  if (statsError) throw statsError;
  if (gamificationError) throw gamificationError;

  const unlockedCodes = new Set((unlocked || []).map((row) => row.badge_code));

  for (const def of defs || []) {
    if (unlockedCodes.has(def.code)) continue;

    let unlockedNow = false;

    if (def.code === "first_session") unlockedNow = Number(stats?.sessions_completed || 0) >= 1;
    if (def.code === "two_sessions") unlockedNow = Number(stats?.sessions_completed || 0) >= 2;
    if (def.code === "three_hours") unlockedNow = Number(stats?.minutes_sung_total || 0) >= 180;
    if (def.code === "weekday_regular") unlockedNow = Number(stats?.sessions_weekday_total || 0) >= 3;
    if (def.code === "group_vibes") unlockedNow = Number(stats?.largest_group_size || 0) >= 3;
    if (def.code === "ten_sessions") unlockedNow = Number(stats?.sessions_completed || 0) >= 10;
    if (def.code === "four_week_streak") unlockedNow = Number(gamification?.streak_best || 0) >= 4;
    if (def.code === "spent_singcoins_once") unlockedNow = Number(stats?.singcoins_spent_total || 0) > 0;

    if (!unlockedNow) continue;

    const { error: insertError } = await supabase.from("user_badges").insert({
      user_id: userId,
      badge_code: def.code,
      unlocked_at: new Date().toISOString(),
      reward_singcoins: Number(def.reward_singcoins || 0),
      reward_xp: Number(def.reward_xp || 0),
      source_event_id: def.code,
    });

    if (insertError) {
      if (String(insertError.code || "") !== "23505") throw insertError;
    } else {
      await creditSingcoins({
        userId,
        amount: Number(def.reward_singcoins || 0),
        type: "badge_reward",
        referenceType: "badge",
        referenceId: def.code,
        label: def.title,
      });

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

  await supabase.from("gamification_events").upsert(
    {
      user_id: userId,
      event_type: "reservation_processed",
      reference_type: "reservation",
      reference_id: String(reservation.id),
      payload: {
        status: reservation.status,
        start_time: reservation.start_time,
        end_time: reservation.end_time,
      },
      processed: true,
      processed_at: new Date().toISOString(),
      created_at: new Date().toISOString(),
    },
    { onConflict: "event_type,reference_type,reference_id" }
  );

  await creditSingcoins({
    userId,
    amount: BASE_RESERVATION_SINGCOINS,
    type: "reservation_reward",
    referenceType: "reservation",
    referenceId: String(reservation.id),
    label: "Réservation validée",
  });

  await creditXp({
    userId,
    amount: BASE_RESERVATION_XP,
    type: "reservation_reward",
    referenceType: "reservation",
    referenceId: String(reservation.id),
    label: "Réservation validée",
  });

  await syncUserStats(userId);
  await syncStreak(userId);
  await syncWeeklyMissions(userId);
  await refreshGamificationSummary(userId);
  await evaluateBadges(userId);
  await syncUserStats(userId);
  await refreshGamificationSummary(userId);

  return getUserGamificationSnapshot(userId);
}

export async function getUserGamificationSnapshot(userId) {
  if (!supabase || !userId) {
    return {
      singcoins: { balance: 0, earned: 0, used: 0 },
      level: { current: 1, name: "Nouveau", xpCurrent: 0, xpNextLevel: 100 },
      streak: { current: 0, best: 0 },
      stats: { totalSessions: 0, totalTime: "0h", totalSongs: 0, lastSession: null },
      records: { bestStreak: 0, biggestSession: 0, longestSessionMinutes: 0 },
      missions: [],
      badges: [],
    };
  }

  await ensureUserRows(userId);
  await ensureMissionDefinitions();
  await ensureBadgeDefinitions();

  const [
    { data: gamification },
    { data: stats },
    { data: badgeDefs },
    { data: userBadges },
    { data: missionDefs },
    { data: missionProgress },
  ] = await Promise.all([
    supabase.from("user_gamification").select("*").eq("user_id", userId).maybeSingle(),
    supabase.from("user_stats").select("*").eq("user_id", userId).maybeSingle(),
    supabase.from("badge_definitions").select("*").eq("is_active", true).order("sort_order"),
    supabase.from("user_badges").select("*").eq("user_id", userId),
    supabase.from("weekly_missions").select("*").eq("is_active", true).order("sort_order"),
    supabase.from("user_mission_progress").select("*").eq("user_id", userId),
  ]);

  const xp = Number(gamification?.xp_total || 0);
  const level = computeLevel(xp);

  const badgeMap = new Map((badgeDefs || []).map((row) => [row.code, row]));
  const badges = (userBadges || [])
    .map((row) => ({
      code: row.badge_code,
      unlockedAt: row.unlocked_at,
      rewardSingcoins: Number(row.reward_singcoins || 0),
      rewardXp: Number(row.reward_xp || 0),
      ...(badgeMap.get(row.badge_code)
        ? {
            title: badgeMap.get(row.badge_code).title,
            description: badgeMap.get(row.badge_code).description,
            rarity: badgeMap.get(row.badge_code).rarity,
            icon: badgeMap.get(row.badge_code).icon,
            sortOrder: badgeMap.get(row.badge_code).sort_order,
          }
        : {}),
    }))
    .sort((a, b) => Number(a.sortOrder || 0) - Number(b.sortOrder || 0));

  const currentWeek = getMondayKey(new Date());
  const missionByKey = new Map(
    (missionProgress || []).map((row) => [`${row.mission_code}:${row.week_start}`, row])
  );

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
      lastValidatedAt: gamification?.streak_last_validated_at || null,
      lastPeriodKey: gamification?.streak_last_period_key || null,
    },
    stats: {
      totalSessions: Number(stats?.sessions_completed || 0),
      totalTime: `${Math.floor(Number(stats?.minutes_sung_total || 0) / 60)}h`,
      totalSongs: Number(stats?.songs_total || 0),
      lastSession: toIsoDate(stats?.last_session_at),
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