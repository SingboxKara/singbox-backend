// backend/middlewares/admin.js

import { CRON_SECRET } from "../config/env.js";

function extractBearerToken(req) {
  const authHeader = req.headers.authorization || "";
  if (!authHeader.startsWith("Bearer ")) return null;
  return authHeader.replace("Bearer ", "").trim();
}

export function isCronAuthorized(req) {
  const token = extractBearerToken(req);
  return token && token === CRON_SECRET;
}

export function requireAdminOrCron(req, res, next) {
  const token = extractBearerToken(req);

  if (token === CRON_SECRET) {
    return next();
  }

  if (!req.user || !req.user.is_admin) {
    return res.status(403).json({
      error: "Accès admin requis",
    });
  }

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