import { supabase } from "../config/supabase.js";

function ensureSupabase() {
  if (!supabase) {
    throw new Error("Supabase non configuré");
  }
}

function safeText(value, maxLen = 255) {
  return String(value ?? "").trim().slice(0, maxLen);
}

function toSafeInt(value, fallback = 0) {
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) ? n : fallback;
}

async function readSingleFromView(viewName, column, value) {
  ensureSupabase();

  const safeValue = safeText(value, 120);
  if (!safeValue) return null;

  const { data, error } = await supabase
    .from(viewName)
    .select("*")
    .eq(column, safeValue)
    .maybeSingle();

  if (error) {
    console.error(`readSingleFromView ${viewName} error:`, error);
    throw error;
  }

  return data || null;
}

export async function getAccountProfile(userId) {
  return readSingleFromView("v_user_profile", "id", userId);
}

export async function getAccountPayment(userId) {
  return readSingleFromView("v_user_payment", "user_id", userId);
}

export async function getAccountReferral(userId) {
  return readSingleFromView("v_user_referral", "user_id", userId);
}

export async function getAccountLoyalty(userId) {
  const row = await readSingleFromView("v_user_loyalty", "user_id", userId);

  if (!row) return null;

  return {
    ...row,
    singcoins_balance: Math.max(0, toSafeInt(row.singcoins_balance, 0)),
    singcoins_earned_total: Math.max(0, toSafeInt(row.singcoins_earned_total, 0)),
    singcoins_used_total: Math.max(0, toSafeInt(row.singcoins_used_total, 0)),
    xp_total: Math.max(0, toSafeInt(row.xp_total, 0)),
    level_current: Math.max(1, toSafeInt(row.level_current, 1)),
    streak_current: Math.max(0, toSafeInt(row.streak_current, 0)),
    streak_best: Math.max(0, toSafeInt(row.streak_best, 0)),
    jokers_available: Math.max(0, toSafeInt(row.jokers_available, 0)),
    sessions_total: Math.max(0, toSafeInt(row.sessions_total, 0)),
    sessions_completed: Math.max(0, toSafeInt(row.sessions_completed, 0)),
    sessions_cancelled: Math.max(0, toSafeInt(row.sessions_cancelled, 0)),
    group_sessions_total: Math.max(0, toSafeInt(row.group_sessions_total, 0)),
    sessions_last_7_days: Math.max(0, toSafeInt(row.sessions_last_7_days, 0)),
    sessions_last_30_days: Math.max(0, toSafeInt(row.sessions_last_30_days, 0)),
    minutes_sung_total: Math.max(0, toSafeInt(row.minutes_sung_total, 0)),
    largest_group_size: Math.max(0, toSafeInt(row.largest_group_size, 0)),
    longest_session_minutes: Math.max(0, toSafeInt(row.longest_session_minutes, 0)),
  };
}

export async function getFullAccountSnapshot(userId) {
  const [profile, payment, referral, loyalty] = await Promise.all([
    getAccountProfile(userId),
    getAccountPayment(userId),
    getAccountReferral(userId),
    getAccountLoyalty(userId),
  ]);

  return {
    profile,
    payment,
    referral,
    loyalty,
  };
}
