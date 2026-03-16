// backend/middlewares/admin.js

import { CRON_SECRET } from "../config/env.js";

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

export function requireAdminOrCron(req, res, next) {
  if (isCronAuthorized(req)) {
    req.isCron = true;
    return next();
  }

  if (!req.user || !req.user.is_admin) {
    return res.status(403).json({
      error: "Accès admin requis",
    });
  }

  req.isCron = false;
  next();
}

export function requireSupabaseAdmin(req, res, next) {
  if (!req.user || !req.user.is_admin) {
    return res.status(403).json({
      error: "Accès admin requis",
    });
  }

  next();
}