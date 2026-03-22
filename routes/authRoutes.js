// backend/routes/authRoutes.js

import express from "express";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";

import { supabase } from "../config/supabase.js";
import { JWT_SECRET } from "../config/env.js";

const router = express.Router();

function normalizeEmail(email) {
  return String(email || "").trim().toLowerCase();
}

function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function isStrongEnoughPassword(password) {
  return typeof password === "string" && password.length >= 8;
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

router.post("/api/register", async (req, res) => {
  try {
    const rawEmail = req.body?.email;
    const password = req.body?.password;

    const email = normalizeEmail(rawEmail);

    if (!email || !password) {
      return res.status(400).json({ error: "Email et mot de passe requis" });
    }

    if (!isValidEmail(email)) {
      return res.status(400).json({ error: "Email invalide" });
    }

    if (!isStrongEnoughPassword(password)) {
      return res.status(400).json({
        error: "Le mot de passe doit contenir au moins 8 caractères",
      });
    }

    if (!supabase) {
      return res.status(500).json({ error: "Supabase non configuré" });
    }

    const { data: existingUser, error: existingUserError } = await supabase
      .from("users")
      .select("id")
      .eq("email", email)
      .maybeSingle();

    if (existingUserError) {
      console.error("Erreur vérification user existant :", existingUserError);
      return res.status(500).json({ error: "Erreur serveur" });
    }

    if (existingUser) {
      return res.status(409).json({ error: "Un compte existe déjà avec cet email" });
    }

    const hash = await bcrypt.hash(password, 12);
    const nowIso = new Date().toISOString();

    const { data: insertedUser, error } = await supabase
      .from("users")
      .insert({
        email,
        password_hash: hash,
        created_at: nowIso,
        updated_at: nowIso,
      })
      .select("id, email")
      .single();

    if (error || !insertedUser) {
      console.error("Erreur register insert :", error);
      return res.status(400).json({ error: error?.message || "Erreur création compte" });
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

router.post("/api/login", async (req, res) => {
  try {
    const rawEmail = req.body?.email;
    const password = req.body?.password;

    const email = normalizeEmail(rawEmail);

    if (!email || !password) {
      return res.status(400).json({ error: "Email et mot de passe requis" });
    }

    if (!isValidEmail(email)) {
      return res.status(400).json({ error: "Identifiants invalides" });
    }

    if (!supabase) {
      return res.status(500).json({ error: "Supabase non configuré" });
    }

    const { data: users, error } = await supabase
      .from("users")
      .select("id, email, password_hash")
      .eq("email", email)
      .limit(1);

    if (error) {
      console.error("Erreur login select :", error);
      return res.status(500).json({ error: "Erreur serveur" });
    }

    const user = users && users[0];
    if (!user) {
      return res.status(401).json({ error: "Identifiants invalides" });
    }

    const ok = await bcrypt.compare(password, user.password_hash);
    if (!ok) {
      return res.status(401).json({ error: "Identifiants invalides" });
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