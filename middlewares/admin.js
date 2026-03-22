// backend/middlewares/admin.js

import jwt from "jsonwebtoken";

import { CRON_SECRET, JWT_SECRET } from "../config/env.js";
import { supabase } from "../config/supabase.js";

function extractBearerToken(req) {
  const authHeader = req.headers.authorization || "";
  if (!authHeader.startsWith("Bearer ")) return null;
  return authHeader.replace("Bearer ", "").trim();
}

export function isCronAuthorized(req) {
  if (!CRON_SECRET) return false;

  const bearerToken = extractBearerToken(req);
  const headerSecret = String(req.headers["x-cron-secret"] || "").trim();

  return bearerToken === CRON_SECRET || headerSecret === CRON_SECRET;
}

async function resolveAppJwtUser(token) {
  if (!JWT_SECRET) {
    throw new Error("JWT_SECRET non configuré");
  }

  const decoded = jwt.verify(token, JWT_SECRET);
  const userId = decoded?.userId || decoded?.id || null;

  if (!userId) {
    return null;
  }

  const { data: user, error } = await supabase
    .from("users")
    .select("id, email")
    .eq("id", userId)
    .maybeSingle();

  if (error) {
    throw error;
  }

  if (!user) {
    return null;
  }

  return {
    id: user.id,
    email: user.email || null,
    source: "app_jwt",
  };
}

async function resolveSupabaseAuthUser(token) {
  const { data: userData, error: userError } = await supabase.auth.getUser(token);

  if (userError || !userData?.user) {
    return null;
  }

  return {
    id: userData.user.id,
    email: userData.user.email || null,
    source: "supabase_auth",
  };
}

async function resolveUserFromToken(token) {
  // 1. priorité au JWT de ton backend (/api/login)
  try {
    const appUser = await resolveAppJwtUser(token);
    if (appUser) return appUser;
  } catch (_err) {
    // on tente ensuite le token Supabase Auth
  }

  // 2. fallback éventuel si un vrai token Supabase est utilisé
  try {
    const supabaseUser = await resolveSupabaseAuthUser(token);
    if (supabaseUser) return supabaseUser;
  } catch (_err) {
    // ignore
  }

  return null;
}

async function resolveSupabaseUserAndAdmin(req) {
  if (!supabase) {
    throw new Error("Supabase non configuré");
  }

  const token = extractBearerToken(req);
  if (!token) {
    return { ok: false, status: 401, error: "Token manquant" };
  }

  const user = await resolveUserFromToken(token);

  if (!user) {
    return { ok: false, status: 401, error: "Token invalide" };
  }

  let adminRow = null;

  const { data: adminByUserId, error: adminByUserIdError } = await supabase
    .from("admin_users")
    .select("user_id, email")
    .eq("user_id", user.id)
    .maybeSingle();

  if (adminByUserIdError) {
    throw adminByUserIdError;
  }

  adminRow = adminByUserId || null;

  if (!adminRow && user.email) {
    const { data: adminByEmail, error: adminByEmailError } = await supabase
      .from("admin_users")
      .select("user_id, email")
      .ilike("email", user.email)
      .maybeSingle();

    if (adminByEmailError) {
      throw adminByEmailError;
    }

    adminRow = adminByEmail || null;
  }

  req.user = {
    id: user.id,
    email: user.email || null,
    is_admin: !!adminRow,
  };
  req.userId = user.id;

  return { ok: true, isAdmin: !!adminRow };
}

export async function requireSupabaseAdmin(req, res, next) {
  try {
    const result = await resolveSupabaseUserAndAdmin(req);

    if (!result.ok) {
      return res.status(result.status).json({ error: result.error });
    }

    if (!result.isAdmin) {
      return res.status(403).json({ error: "Accès admin requis" });
    }

    return next();
  } catch (error) {
    console.error("❌ requireSupabaseAdmin error:", error);
    return res.status(500).json({ error: "Erreur serveur auth admin" });
  }
}

export async function requireAdminOrCron(req, res, next) {
  try {
    if (isCronAuthorized(req)) {
      req.isCron = true;
      return next();
    }

    const result = await resolveSupabaseUserAndAdmin(req);

    if (!result.ok) {
      return res.status(result.status).json({ error: result.error });
    }

    if (!result.isAdmin) {
      return res.status(403).json({ error: "Accès admin requis" });
    }

    req.isCron = false;
    return next();
  } catch (error) {
    console.error("❌ requireAdminOrCron error:", error);
    return res.status(500).json({ error: "Erreur serveur auth admin" });
  }
}