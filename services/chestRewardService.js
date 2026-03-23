// backend/services/chestRewardService.js

import crypto from "crypto";

import { supabase } from "../config/supabase.js";
import { creditSingcoins } from "./gamificationService.js";

const COMPLETED_STATUSES = ["completed"];
const SESSIONS_PER_CHEST = 5;
const ACTIVE_REWARD_TTL_HOURS = 3;

const REWARDS_POOL = [
  {
    id: "empty",
    type: "none",
    label: "Pas de gain cette fois",
    description:
      "Le coffre était vide... mais le prochain sera peut-être le bon.",
    weight: 45,
    value: 0,
  },
  {
    id: "coins_20",
    type: "points",
    label: "+20 Singcoins",
    description: "Tu gagnes 20 Singcoins.",
    weight: 25,
    value: 20,
  },
  {
    id: "coins_30",
    type: "points",
    label: "+30 Singcoins",
    description: "Tu gagnes 30 Singcoins.",
    weight: 15,
    value: 30,
  },
  {
    id: "discount_10_percent",
    type: "discount_percent",
    label: "-10% sur ta réservation",
    description: "Réduction de 10% sur une réservation.",
    weight: 10,
    value: 10,
  },
  {
    id: "discount_20_percent",
    type: "discount_percent",
    label: "-20% sur ta réservation",
    description: "Réduction de 20% sur une réservation.",
    weight: 4,
    value: 20,
  },
  {
    id: "free_session",
    type: "free_session",
    label: "Session offerte",
    description: "Tu as gagné une session offerte.",
    weight: 1,
    value: 1,
  },
];

function assertSupabaseConfigured() {
  if (!supabase) {
    throw new Error("Supabase non configuré");
  }
}

function normalizeStatus(value) {
  return String(value || "").trim().toLowerCase();
}

function qualifiesForCompleted(value) {
  return COMPLETED_STATUSES.includes(normalizeStatus(value));
}

function addHours(date, hours) {
  return new Date(date.getTime() + hours * 60 * 60 * 1000);
}

function toIsoDate(date) {
  return date.toISOString().slice(0, 10);
}

function weightedRandom(pool) {
  const total = pool.reduce((sum, item) => sum + Number(item.weight || 0), 0);
  let threshold = Math.random() * total;

  for (const item of pool) {
    threshold -= Number(item.weight || 0);
    if (threshold <= 0) {
      return item;
    }
  }

  return pool[pool.length - 1];
}

function normalizeRewardRow(row) {
  if (!row) return null;

  return {
    id: row.id,
    rewardId: row.id,
    type: row.reward_type,
    value: Number(row.reward_value || 0),
    label: row.reward_label,
    description: row.reward_description || "",
    status: row.status,
    promoCode: row.promo_code || null,
    openedAt: row.opened_at || null,
    expiresAt: row.expires_at || null,
    sourceType: row.source_type,
    sourceValue: Number(row.source_value || 0),
    isEmpty: row.reward_type === "none",
  };
}

async function getCompletedSessionsCount(userId) {
  assertSupabaseConfigured();

  const { data: stats, error: statsError } = await supabase
    .from("user_stats")
    .select("sessions_completed")
    .eq("user_id", userId)
    .maybeSingle();

  if (!statsError && stats && Number.isFinite(Number(stats.sessions_completed))) {
    return Math.max(0, Number(stats.sessions_completed));
  }

  const { data, error } = await supabase
    .from("reservations")
    .select("status")
    .eq("user_id", userId);

  if (error) throw error;

  return (data || []).filter((row) => qualifiesForCompleted(row.status)).length;
}

async function expireStaleRewards(userId) {
  assertSupabaseConfigured();

  const nowIso = new Date().toISOString();

  const { data: staleRows, error: readError } = await supabase
    .from("chest_rewards")
    .select("id, promo_code")
    .eq("user_id", userId)
    .eq("status", "active")
    .lt("expires_at", nowIso);

  if (readError) throw readError;

  const stale = staleRows || [];
  if (stale.length === 0) return;

  const staleIds = stale.map((row) => row.id);
  const promoCodes = stale.map((row) => row.promo_code).filter(Boolean);

  const { error: updateRewardsError } = await supabase
    .from("chest_rewards")
    .update({
      status: "expired",
      updated_at: nowIso,
    })
    .in("id", staleIds);

  if (updateRewardsError) throw updateRewardsError;

  if (promoCodes.length > 0) {
    const { error: promoError } = await supabase
      .from("promo_codes")
      .update({
        is_active: false,
      })
      .in("code", promoCodes);

    if (promoError) {
      console.error("Erreur désactivation promo coffre expirée :", promoError);
    }
  }
}

async function getActiveReward(userId) {
  assertSupabaseConfigured();
  await expireStaleRewards(userId);

  const { data, error } = await supabase
    .from("chest_rewards")
    .select("*")
    .eq("user_id", userId)
    .eq("status", "active")
    .order("opened_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) throw error;
  return data || null;
}

async function hasWelcomeAlreadyOpened(userId) {
  const { data, error } = await supabase
    .from("chest_rewards")
    .select("id")
    .eq("user_id", userId)
    .eq("source_type", "welcome")
    .limit(1)
    .maybeSingle();

  if (error) throw error;
  return !!data;
}

async function getOpenedMilestones(userId) {
  const { data, error } = await supabase
    .from("chest_rewards")
    .select("source_value")
    .eq("user_id", userId)
    .eq("source_type", "sessions");

  if (error) throw error;

  return new Set(
    (data || [])
      .map((row) => Number(row.source_value || 0))
      .filter((value) => Number.isFinite(value) && value > 0)
  );
}

function buildMilestones(completedSessions) {
  const milestones = [];
  for (let milestone = SESSIONS_PER_CHEST; milestone <= completedSessions; milestone += SESSIONS_PER_CHEST) {
    milestones.push(milestone);
  }
  return milestones;
}

function buildOneShotPromoCode() {
  const suffix = crypto.randomBytes(4).toString("hex").toUpperCase();
  return `CHEST-${suffix}`;
}

async function createPromoCodeForReward(rewardType, rewardValue, userId) {
  assertSupabaseConfigured();

  const code = buildOneShotPromoCode();
  const now = new Date();
  const validFrom = toIsoDate(now);
  const validTo = toIsoDate(addHours(now, ACTIVE_REWARD_TTL_HOURS));

  const type = rewardType === "free_session" ? "free" : "percent";
  const value = rewardType === "free_session" ? 100 : Number(rewardValue || 0);

  const { error } = await supabase
    .from("promo_codes")
    .insert({
      code,
      type,
      value,
      is_active: true,
      valid_from: validFrom,
      valid_to: validTo,
      max_uses: 1,
      used_count: 0,
      max_uses_per_user: 1,
      first_session_only: false,
      email_domain: null,
      note: `Chest reward for user ${userId}`,
    });

  if (error) throw error;

  return code;
}

export async function getChestStateForUser(userId) {
  assertSupabaseConfigured();

  if (!userId) {
    return {
      availableCount: 0,
      welcomeAvailable: false,
      milestoneChests: [],
      completedSessions: 0,
      nextMilestone: SESSIONS_PER_CHEST,
      activeReward: null,
      mode: "logged_out",
    };
  }

  const completedSessions = await getCompletedSessionsCount(userId);
  const welcomeAlreadyOpened = await hasWelcomeAlreadyOpened(userId);
  const openedMilestones = await getOpenedMilestones(userId);
  const activeRewardRow = await getActiveReward(userId);

  const allMilestones = buildMilestones(completedSessions);
  const milestoneChests = allMilestones.filter(
    (milestone) => !openedMilestones.has(milestone)
  );

  const welcomeAvailable = !welcomeAlreadyOpened;
  const availableCount =
    (welcomeAvailable ? 1 : 0) + milestoneChests.length;

  const nextMilestone =
    Math.ceil(Math.max(1, completedSessions) / SESSIONS_PER_CHEST) *
    SESSIONS_PER_CHEST;

  return {
    availableCount,
    welcomeAvailable,
    milestoneChests,
    completedSessions,
    nextMilestone,
    activeReward: normalizeRewardRow(activeRewardRow),
    mode: activeRewardRow
      ? "opened"
      : availableCount > 0
        ? "available"
        : "locked",
  };
}

async function persistReward({
  userId,
  sourceType,
  sourceValue,
  pickedReward,
}) {
  assertSupabaseConfigured();

  const now = new Date();
  const expiresAt = addHours(now, ACTIVE_REWARD_TTL_HOURS).toISOString();

  let status = "opened_empty";
  let promoCode = null;

  if (pickedReward.type === "points") {
    await creditSingcoins({
      userId,
      amount: Number(pickedReward.value || 0),
      type: "chest_reward",
      referenceType: "chest_reward",
      referenceId: `${sourceType}:${sourceValue}:${Date.now()}`,
      label: pickedReward.label,
    });

    status = "credited";
  } else if (pickedReward.type === "discount_percent" || pickedReward.type === "free_session") {
    promoCode = await createPromoCodeForReward(
      pickedReward.type,
      pickedReward.value,
      userId
    );
    status = "active";
  }

  const payload = {
    user_id: userId,
    source_type: sourceType,
    source_value: Number(sourceValue || 0),
    reward_type: pickedReward.type,
    reward_value: Number(pickedReward.value || 0),
    reward_label: pickedReward.label,
    reward_description: pickedReward.description,
    promo_code: promoCode,
    status,
    opened_at: now.toISOString(),
    expires_at: status === "active" ? expiresAt : null,
    updated_at: now.toISOString(),
  };

  const { data, error } = await supabase
    .from("chest_rewards")
    .insert(payload)
    .select("*")
    .single();

  if (error) throw error;

  return normalizeRewardRow(data);
}

export async function openChestForUser(userId) {
  assertSupabaseConfigured();

  if (!userId) {
    throw new Error("Utilisateur manquant");
  }

  const state = await getChestStateForUser(userId);

  if (state.activeReward) {
    return {
      ok: false,
      reason: "Une récompense coffre est déjà active.",
      state,
      reward: state.activeReward,
    };
  }

  let sourceType = null;
  let sourceValue = 0;

  if (state.welcomeAvailable) {
    sourceType = "welcome";
    sourceValue = 1;
  } else if (state.milestoneChests.length > 0) {
    sourceType = "sessions";
    sourceValue = state.milestoneChests[0];
  } else {
    return {
      ok: false,
      reason: "Aucun coffre disponible.",
      state,
      reward: null,
    };
  }

  const pickedReward = weightedRandom(REWARDS_POOL);
  const reward = await persistReward({
    userId,
    sourceType,
    sourceValue,
    pickedReward,
  });

  const nextState = await getChestStateForUser(userId);

  return {
    ok: true,
    reward,
    state: nextState,
  };
}

export async function getActiveChestRewardForUser(userId) {
  const row = await getActiveReward(userId);
  return normalizeRewardRow(row);
}