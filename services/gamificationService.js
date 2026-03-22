import { supabaseAdmin } from '../config/supabase.js';

function computeLevel(xp) {
  const level = Math.min(100, Math.floor(xp / 100) + 1);
  return {
    level,
    name: `Niveau ${level}`,
    xpCurrent: xp % 100,
    xpNext: 100
  };
}

export async function getUserGamificationSnapshot(userId) {
  // gamification
  const { data: gamification } = await supabaseAdmin
    .from('user_gamification')
    .select('*')
    .eq('user_id', userId)
    .single();

  // stats
  const { data: stats } = await supabaseAdmin
    .from('user_stats')
    .select('*')
    .eq('user_id', userId)
    .single();

  // badges
  const { data: badges } = await supabaseAdmin
    .from('user_badges')
    .select('*')
    .eq('user_id', userId);

  // missions
  const { data: missions } = await supabaseAdmin
    .from('user_mission_progress')
    .select('*')
    .eq('user_id', userId);

  const level = computeLevel(gamification?.xp_total || 0);

  return {
    identity: {
      displayName: "Utilisateur",
      memberSince: null,
      status: "Membre"
    },
    singcoins: {
      balance: gamification?.singcoins_balance || 0,
      earned: gamification?.singcoins_earned_total || 0,
      used: gamification?.singcoins_used_total || 0,
      nextReward: "100 Singcoins"
    },
    level: {
      current: level.level,
      name: level.name,
      xpCurrent: level.xpCurrent,
      xpNextLevel: level.xpNext
    },
    streak: {
      current: gamification?.streak_current || 0,
      best: gamification?.streak_best || 0,
      status: "active"
    },
    stats: {
      totalSessions: stats?.sessions_completed || 0,
      totalTime: `${Math.floor((stats?.minutes_sung_total || 0) / 60)}h`,
      totalSongs: stats?.songs_total || 0,
      lastSession: stats?.last_session_at || null
    },
    records: {
      bestStreak: gamification?.streak_best || 0,
      biggestSession: stats?.largest_group_size || 0
    },
    missions: missions || [],
    badges: badges || []
  };
}