// backend/services/leaderboardService.js

import { supabase } from "../config/supabase.js";

const DEFAULT_LIMIT = 5;
const MAX_LIMIT = 10;

function clampLimit(value) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_LIMIT;
  return Math.min(parsed, MAX_LIMIT);
}

function normalizeText(value) {
  if (typeof value !== "string") return "";
  return value.trim().replace(/\s+/g, " ");
}

function buildDisplayName(user) {
  const prenom = normalizeText(user?.prenom);
  const nom = normalizeText(user?.nom);

  if (prenom && nom) {
    return `${prenom} ${nom.charAt(0).toUpperCase()}.`;
  }

  if (prenom) {
    return prenom;
  }

  return "Membre Singbox";
}

async function fetchUsersMap(userIds) {
  const uniqueIds = [...new Set((userIds || []).filter(Boolean))];

  if (uniqueIds.length === 0) {
    return new Map();
  }

  const { data, error } = await supabase
    .from("users")
    .select("id, prenom, nom")
    .in("id", uniqueIds);

  if (error) {
    throw new Error(`Impossible de charger les utilisateurs: ${error.message}`);
  }

  const map = new Map();

  for (const user of data || []) {
    map.set(user.id, {
      prenom: user.prenom,
      nom: user.nom,
      display_name: buildDisplayName(user),
    });
  }

  return map;
}

function attachDisplayNames(rows, usersMap) {
  return (rows || []).map((row) => {
    const user = usersMap.get(row.user_id);

    return {
      ...row,
      display_name: user?.display_name || "Membre Singbox",
    };
  });
}

export async function getHomeLeaderboards(rawLimit) {
  if (!supabase) {
    throw new Error("Supabase non configuré");
  }

  const limit = clampLimit(rawLimit);

  const streakPromise = supabase
    .from("user_gamification")
    .select("user_id, streak_current, streak_best, level_current, xp_total")
    .gt("streak_current", 0)
    .order("streak_current", { ascending: false })
    .order("streak_best", { ascending: false })
    .order("xp_total", { ascending: false })
    .limit(limit);

  const sessionsPromise = supabase
    .from("user_stats")
    .select("user_id, sessions_completed, sessions_total, minutes_sung_total, last_session_at")
    .gt("sessions_completed", 0)
    .order("sessions_completed", { ascending: false })
    .order("minutes_sung_total", { ascending: false })
    .order("last_session_at", { ascending: false, nullsFirst: false })
    .limit(limit);

  const levelCandidatesPromise = supabase
    .from("user_gamification")
    .select("user_id, level_current, level_name, xp_total, streak_current")
    .gt("level_current", 0)
    .order("level_current", { ascending: false })
    .order("xp_total", { ascending: false })
    .order("streak_current", { ascending: false })
    .limit(limit * 5);

  const [
    { data: streakRows, error: streakError },
    { data: sessionRows, error: sessionError },
    { data: levelCandidates, error: levelError },
  ] = await Promise.all([streakPromise, sessionsPromise, levelCandidatesPromise]);

  if (streakError) {
    throw new Error(`Impossible de charger le leaderboard streak: ${streakError.message}`);
  }

  if (sessionError) {
    throw new Error(`Impossible de charger le leaderboard sessions: ${sessionError.message}`);
  }

  if (levelError) {
    throw new Error(`Impossible de charger le leaderboard niveaux: ${levelError.message}`);
  }

  const sessionRowsSafe = sessionRows || [];
  const streakRowsSafe = streakRows || [];
  const levelCandidatesSafe = levelCandidates || [];

  const sessionsByUserId = new Map(
    sessionRowsSafe.map((row) => [row.user_id, row])
  );

  const filteredLevels = levelCandidatesSafe
    .map((row) => ({
      ...row,
      sessions_completed: sessionsByUserId.get(row.user_id)?.sessions_completed ?? 0,
    }))
    .filter((row) => row.sessions_completed > 0)
    .sort((a, b) => {
      if (b.level_current !== a.level_current) return b.level_current - a.level_current;
      if (b.xp_total !== a.xp_total) return b.xp_total - a.xp_total;
      if (b.streak_current !== a.streak_current) return b.streak_current - a.streak_current;
      return b.sessions_completed - a.sessions_completed;
    })
    .slice(0, limit);

  const allUserIds = [
    ...streakRowsSafe.map((row) => row.user_id),
    ...sessionRowsSafe.map((row) => row.user_id),
    ...filteredLevels.map((row) => row.user_id),
  ];

  const usersMap = await fetchUsersMap(allUserIds);

  return {
    streak: attachDisplayNames(streakRowsSafe, usersMap).map((row, index) => ({
      rank: index + 1,
      user_id: row.user_id,
      display_name: row.display_name,
      streak_current: row.streak_current,
      streak_best: row.streak_best,
      level_current: row.level_current,
      xp_total: row.xp_total,
    })),

    sessions: attachDisplayNames(sessionRowsSafe, usersMap).map((row, index) => ({
      rank: index + 1,
      user_id: row.user_id,
      display_name: row.display_name,
      sessions_completed: row.sessions_completed,
      sessions_total: row.sessions_total,
      minutes_sung_total: row.minutes_sung_total,
      last_session_at: row.last_session_at,
    })),

    levels: attachDisplayNames(filteredLevels, usersMap).map((row, index) => ({
      rank: index + 1,
      user_id: row.user_id,
      display_name: row.display_name,
      level_current: row.level_current,
      level_name: row.level_name,
      xp_total: row.xp_total,
      streak_current: row.streak_current,
      sessions_completed: row.sessions_completed,
    })),
  };
}