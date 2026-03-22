// backend/middlewares/auth.js

import jwt from "jsonwebtoken";
import { JWT_SECRET } from "../config/env.js";

function extractBearerToken(req) {
  const authHeader = req.headers.authorization || "";

  if (!authHeader.startsWith("Bearer ")) {
    return null;
  }

  return authHeader.replace("Bearer ", "").trim();
}

function verifyUserToken(token) {
  if (!JWT_SECRET) {
    throw new Error("JWT_SECRET manquant");
  }

  const decoded = jwt.verify(token, JWT_SECRET, {
    algorithms: ["HS256"],
  });

  if (!decoded || !decoded.userId) {
    throw new Error("Payload token invalide");
  }

  return decoded;
}

export function authMiddleware(req, res, next) {
  try {
    const token = extractBearerToken(req);

    if (!token) {
      return res.status(401).json({ error: "Token manquant" });
    }

    const decoded = verifyUserToken(token);

    req.user = decoded;
    req.userId = decoded.userId;

    return next();
  } catch (error) {
    console.error("❌ Auth error:", error.message);
    return res.status(401).json({ error: "Token invalide" });
  }
}

export function optionalAuthMiddleware(req, res, next) {
  try {
    const token = extractBearerToken(req);

    if (!token) {
      return next();
    }

    const decoded = verifyUserToken(token);

    req.user = decoded;
    req.userId = decoded.userId;

    return next();
  } catch (_error) {
    return next();
  }
}