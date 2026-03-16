// backend/routes/authRoutes.js

import express from "express";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";

import { supabase } from "../config/supabase.js";
import { JWT_SECRET } from "../config/env.js";

const router = express.Router();

router.post("/api/register", async (req, res) => {
  try {
    const { email, password } = req.body || {};

    if (!email || !password) {
      return res.status(400).json({ error: "Email et mot de passe requis" });
    }

    if (!supabase) {
      return res.status(500).json({ error: "Supabase non configuré" });
    }

    const hash = await bcrypt.hash(password, 10);

    const { error } = await supabase.from("users").insert({
      email,
      password_hash: hash,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });

    if (error) {
      console.error(error);
      return res.status(400).json({ error: error.message });
    }

    return res.json({ message: "Compte créé" });
  } catch (err) {
    console.error("Erreur register :", err);
    return res.status(500).json({ error: "Erreur serveur" });
  }
});

router.post("/api/login", async (req, res) => {
  try {
    const { email, password } = req.body || {};

    if (!email || !password) {
      return res.status(400).json({ error: "Email et mot de passe requis" });
    }

    if (!supabase) {
      return res.status(500).json({ error: "Supabase non configuré" });
    }

    const { data: users, error } = await supabase
      .from("users")
      .select("*")
      .eq("email", email)
      .limit(1);

    if (error) {
      return res.status(400).json({ error: error.message });
    }

    const user = users && users[0];
    if (!user) {
      return res.status(400).json({ error: "Email inconnu" });
    }

    const ok = await bcrypt.compare(password, user.password_hash);
    if (!ok) {
      return res.status(400).json({ error: "Mot de passe incorrect" });
    }

    const token = jwt.sign({ userId: user.id }, JWT_SECRET, {
      expiresIn: "7d",
    });

    return res.json({ token });
  } catch (err) {
    console.error("Erreur login :", err);
    return res.status(500).json({ error: "Erreur serveur" });
  }
});

export default router;