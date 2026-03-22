import { supabase } from '../config/supabase.js';

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
  // 🔥 IMPORTANT → pas de .single()
  const { data: gamification } = await supabase
    .from('user_gamification')
    .select('*')
    .eq('user_id', userId)
    .maybeSingle();

  const { data: stats } = await supabase
    .from('user_stats')
    .select('*')
    .eq('user_id', userId)
    .maybeSingle();

  const { data: badges } = await supabase
    .from('user_badges')
    .select('*')
    .eq('user_id', userId);

  const { data: missions } = await supabase
    .from('user_mission_progress')
    .select('*')
    .eq('user_id', userId);

  const xp = gamification?.xp_total || 0;
  const level = computeLevel(xp);

  return {
    singcoins: {
      balance: gamification?.singcoins_balance || 0,
      earned: gamification?.singcoins_earned_total || 0,
      used: gamification?.singcoins_used_total || 0
    },
    level: {
      current: level.level,
      name: level.name,
      xpCurrent: level.xpCurrent,
      xpNextLevel: level.xpNext
    },
    streak: {
      current: gamification?.streak_current || 0,
      best: gamification?.streak_best || 0
    },
    stats: {
      totalSessions: stats?.sessions_completed || 0,
      totalTime: `${Math.floor((stats?.minutes_sung_total || 0) / 60)}h`,
      totalSongs: stats?.songs_total || 0
    },
    missions: missions || [],
    badges: badges || []
  };
}