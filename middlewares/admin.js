// backend/middlewares/admin.js

import jwt from "jsonwebtoken";

import { CRON_SECRET, JWT_SECRET } from "../config/env.js";
import { supabase } from "../config/supabase.js";

function extractBearerToken(req) {
  const authHeader = String(req?.headers?.authorization || "").trim();

  if (!authHeader.startsWith("Bearer ")) {
    return null;
  }

  const token = authHeader.slice("Bearer ".length).trim();
  return token || null;
}

function normalizeEmail(email) {
  return String(email || "").trim().toLowerCase();
}

function safeTrim(value) {
  return String(value || "").trim();
}

function hasSupabase() {
  return !!supabase;
}

function buildAuthUser({ id = null, email = null, isAdmin = false, source = null }) {
  return {
    id,
    email: email || null,
    is_admin: !!isAdmin,
    auth_source: source || null,
  };
}

function applyRequestUser(req, user) {
  req.user = user;
  req.userId = user?.id || null;
}

export function isCronAuthorized(req) {
  const configuredSecret = safeTrim(CRON_SECRET);
  if (!configuredSecret) return false;

  const bearerToken = extractBearerToken(req);
  const headerSecret = safeTrim(req?.headers?.["x-cron-secret"]);

  return bearerToken === configuredSecret || headerSecret === configuredSecret;
}

async function resolveAppJwtUser(token) {
  if (!JWT_SECRET) {
    throw new Error("JWT_SECRET non configuré");
  }

  if (!token) {
    return null;
  }

  const decoded = jwt.verify(token, JWT_SECRET, {
    algorithms: ["HS256"],
  });

  const userId = decoded?.userId || decoded?.id || null;

  if (!userId) {
    return null;
  }

  if (!hasSupabase()) {
    throw new Error("Supabase non configuré");
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
    email: normalizeEmail(user.email),
    source: "app_jwt",
  };
}

async function resolveSupabaseAuthUser(token) {
  if (!token || !hasSupabase()) {
    return null;
  }

  const { data: userData, error: userError } = await supabase.auth.getUser(token);

  if (userError || !userData?.user) {
    return null;
  }

  return {
    id: userData.user.id,
    email: normalizeEmail(userData.user.email),
    source: "supabase_auth",
  };
}

async function resolveUserFromToken(token) {
  if (!token) return null;

  try {
    const appUser = await resolveAppJwtUser(token);
    if (appUser) return appUser;
  } catch (_err) {
    // fallback vers Supabase auth
  }

  try {
    const supabaseUser = await resolveSupabaseAuthUser(token);
    if (supabaseUser) return supabaseUser;
  } catch (_err) {
    // ignore
  }

  return null;
}

async function findAdminRowForUser(user) {
  if (!hasSupabase()) {
    throw new Error("Supabase non configuré");
  }

  if (!user?.id) {
    return null;
  }

  const { data: adminByUserId, error: adminByUserIdError } = await supabase
    .from("admin_users")
    .select("user_id, email")
    .eq("user_id", user.id)
    .maybeSingle();

  if (adminByUserIdError) {
    throw adminByUserIdError;
  }

  if (adminByUserId) {
    return adminByUserId;
  }

  if (!user.email) {
    return null;
  }

  const normalizedUserEmail = normalizeEmail(user.email);

  const { data: adminByEmail, error: adminByEmailError } = await supabase
    .from("admin_users")
    .select("user_id, email")
    .ilike("email", normalizedUserEmail)
    .maybeSingle();

  if (adminByEmailError) {
    throw adminByEmailError;
  }

  return adminByEmail || null;
}

async function resolveSupabaseUserAndAdmin(req) {
  if (!hasSupabase()) {
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

  const adminRow = await findAdminRowForUser(user);

  const requestUser = buildAuthUser({
    id: user.id,
    email: user.email || null,
    isAdmin: !!adminRow,
    source: user.source || null,
  });

  applyRequestUser(req, requestUser);

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

    req.isCron = false;
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

      applyRequestUser(
        req,
        buildAuthUser({
          id: null,
          email: null,
          isAdmin: true,
          source: "cron",
        })
      );

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
