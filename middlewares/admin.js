// backend/middlewares/admin.js

import { CRON_SECRET } from "../config/env.js";
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

async function resolveSupabaseUserAndAdmin(req) {
  if (!supabase) {
    throw new Error("Supabase non configuré");
  }

  const token = extractBearerToken(req);
  if (!token) {
    return { ok: false, status: 401, error: "Token manquant" };
  }

  const { data: userData, error: userError } = await supabase.auth.getUser(token);

  if (userError || !userData?.user) {
    return { ok: false, status: 401, error: "Token invalide" };
  }

  const user = userData.user;

  const { data: adminRow, error: adminError } = await supabase
    .from("admin_users")
    .select("user_id, email")
    .eq("user_id", user.id)
    .maybeSingle();

  if (adminError) {
    throw adminError;
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