// backend/middlewares/auth.js

import jwt from "jsonwebtoken";
import { JWT_SECRET } from "../config/env.js";

function extractBearerToken(req) {
  const authHeader = req.headers.authorization || "";

  if (!authHeader.startsWith("Bearer ")) {
    return null;
  }

  const token = authHeader.replace("Bearer ", "").trim();
  return token || null;
}

function normalizeDecodedToken(decoded) {
  if (!decoded || typeof decoded !== "object") {
    throw new Error("Payload token invalide");
  }

  const userId = decoded.userId || decoded.id || null;

  if (!userId) {
    throw new Error("Payload token invalide");
  }

  return {
    ...decoded,
    userId,
  };
}

function verifyUserToken(token) {
  if (!JWT_SECRET) {
    throw new Error("JWT_SECRET manquant");
  }

  if (!token) {
    throw new Error("Token manquant");
  }

  const decoded = jwt.verify(token, JWT_SECRET, {
    algorithms: ["HS256"],
  });

  return normalizeDecodedToken(decoded);
}

function buildAuthUser(decoded) {
  return {
    ...decoded,
    userId: decoded.userId,
  };
}

export function authMiddleware(req, res, next) {
  try {
    const token = extractBearerToken(req);

    if (!token) {
      return res.status(401).json({ error: "Token manquant" });
    }

    const decoded = verifyUserToken(token);

    req.user = buildAuthUser(decoded);
    req.userId = decoded.userId;

    return next();
  } catch (error) {
    console.error("❌ Auth error:", error.message);

    return res.status(401).json({
      error:
        error.message === "JWT_SECRET manquant"
          ? "Authentification indisponible"
          : "Token invalide",
    });
  }
}

export function optionalAuthMiddleware(req, res, next) {
  try {
    const token = extractBearerToken(req);

    if (!token) {
      req.user = null;
      req.userId = null;
      return next();
    }

    const decoded = verifyUserToken(token);

    req.user = buildAuthUser(decoded);
    req.userId = decoded.userId;

    return next();
  } catch (_error) {
    req.user = null;
    req.userId = null;
    return next();
  }
}
