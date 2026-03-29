// backend/routes/authRoutes.js

import express from "express";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";

import { supabase } from "../config/supabase.js";
import { JWT_SECRET } from "../config/env.js";

const router = express.Router();

const PASSWORD_MIN_LENGTH = 8;
const PASSWORD_MAX_LENGTH = 72; // bcrypt tronque au-delà, donc on bloque à la création
const BCRYPT_ROUNDS = 12;

function normalizeEmail(email) {
  return String(email || "").trim().toLowerCase();
}

function safeText(value, maxLen = 255) {
  return String(value || "").trim().slice(0, maxLen);
}

function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function isStrongEnoughPassword(password) {
  return (
    typeof password === "string"
    && password.length >= PASSWORD_MIN_LENGTH
    && password.length <= PASSWORD_MAX_LENGTH
  );
}

function getPasswordValidationError(password) {
  if (typeof password !== "string" || password.length === 0) {
    return "Email et mot de passe requis";
  }

  if (password.length < PASSWORD_MIN_LENGTH) {
    return `Le mot de passe doit contenir au moins ${PASSWORD_MIN_LENGTH} caractères`;
  }

  if (password.length > PASSWORD_MAX_LENGTH) {
    return `Le mot de passe doit contenir au maximum ${PASSWORD_MAX_LENGTH} caractères`;
  }

  return null;
}

function ensureAuthDependencies(res) {
  if (!supabase) {
    res.status(500).json({ error: "Supabase non configuré" });
    return false;
  }

  if (!JWT_SECRET) {
    res.status(500).json({ error: "Authentification indisponible" });
    return false;
  }

  return true;
}

function buildUserToken(user) {
  return jwt.sign(
    {
      userId: user.id,
      email: user.email,
      type: "user",
    },
    JWT_SECRET,
    {
      expiresIn: "7d",
      algorithm: "HS256",
    }
  );
}

async function findUserByEmail(email) {
  const { data, error } = await supabase
    .from("users")
    .select("id, email, password_hash")
    .eq("email", email)
    .limit(1);

  if (error) {
    throw error;
  }

  return Array.isArray(data) && data.length > 0 ? data[0] : null;
}

/* =========================================================
   REGISTER
========================================================= */

router.post("/api/register", async (req, res) => {
  try {
    if (!ensureAuthDependencies(res)) return;

    const rawEmail = req.body?.email;
    const rawPassword = req.body?.password;

    const email = normalizeEmail(rawEmail);
    const password = typeof rawPassword === "string" ? rawPassword : "";

    if (!email || !password) {
      return res.status(400).json({
        error: "Email et mot de passe requis",
      });
    }

    if (!isValidEmail(email)) {
      return res.status(400).json({
        error: "Email invalide",
      });
    }

    const passwordError = getPasswordValidationError(password);
    if (passwordError) {
      return res.status(400).json({
        error: passwordError,
      });
    }

    if (!isStrongEnoughPassword(password)) {
      return res.status(400).json({
        error: `Le mot de passe doit contenir entre ${PASSWORD_MIN_LENGTH} et ${PASSWORD_MAX_LENGTH} caractères`,
      });
    }

    const existingUser = await findUserByEmail(email);

    if (existingUser) {
      return res.status(409).json({
        error: "Un compte existe déjà avec cet email",
      });
    }

    const hash = await bcrypt.hash(password, BCRYPT_ROUNDS);
    const nowIso = new Date().toISOString();

    const insertPayload = {
      email,
      password_hash: hash,
      created_at: nowIso,
      updated_at: nowIso,
    };

    const { data: insertedUser, error } = await supabase
      .from("users")
      .insert(insertPayload)
      .select("id, email")
      .single();

    if (error || !insertedUser) {
      console.error("Erreur register insert :", error);
      return res.status(400).json({
        error: error?.message || "Erreur création compte",
      });
    }

    const token = buildUserToken(insertedUser);

    return res.status(201).json({
      message: "Compte créé",
      token,
      user: {
        id: insertedUser.id,
        email: insertedUser.email,
      },
    });
  } catch (err) {
    console.error("Erreur register :", err);
    return res.status(500).json({ error: "Erreur serveur" });
  }
});

/* =========================================================
   LOGIN
========================================================= */

router.post("/api/login", async (req, res) => {
  try {
    if (!ensureAuthDependencies(res)) return;

    const rawEmail = req.body?.email;
    const rawPassword = req.body?.password;

    const email = normalizeEmail(rawEmail);
    const password = typeof rawPassword === "string" ? rawPassword : "";

    if (!email || !password) {
      return res.status(400).json({
        error: "Email et mot de passe requis",
      });
    }

    if (!isValidEmail(email)) {
      return res.status(400).json({
        error: "Identifiants invalides",
      });
    }

    const user = await findUserByEmail(email);

    if (!user) {
      return res.status(401).json({
        error: "Identifiants invalides",
      });
    }

    if (!user.password_hash) {
      console.error("Utilisateur sans password_hash :", safeText(user.id, 120));
      return res.status(401).json({
        error: "Identifiants invalides",
      });
    }

    const ok = await bcrypt.compare(password, user.password_hash);

    if (!ok) {
      return res.status(401).json({
        error: "Identifiants invalides",
      });
    }

    const token = buildUserToken(user);

    return res.json({
      token,
      user: {
        id: user.id,
        email: user.email,
      },
    });
  } catch (err) {
    console.error("Erreur login :", err);
    return res.status(500).json({ error: "Erreur serveur" });
  }
});

export default router;
