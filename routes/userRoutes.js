import express from "express";
import { authMiddleware } from "../middlewares/auth.js";
import { getUserById, updateUserById } from "../services/userService.js";

const router = express.Router();

function safeText(value, maxLen = 160) {
  return String(value || "").trim().slice(0, maxLen);
}

function safeEmail(value) {
  return safeText(value, 160).toLowerCase();
}

function safeCountry(value) {
  const raw = safeText(value, 20).toUpperCase();
  if (!raw) return "FR";
  return raw;
}

function safeBirthdate(value) {
  const raw = safeText(value, 20);
  if (!raw) return null;
  return /^\d{4}-\d{2}-\d{2}$/.test(raw) ? raw : null;
}

function normalizeUserResponse(user) {
  if (!user || typeof user !== "object") {
    return {
      id: null,
      email: null,
      profile: {},
      payment: {
        default_payment_method_id: null,
        card: null,
      },
    };
  }

  return {
    id: user.id ?? null,
    email: user.email ?? null,

    profile: {
      prenom: user.prenom ?? "",
      nom: user.nom ?? "",
      telephone: user.telephone ?? "",
      pays: user.pays ?? "FR",
      adresse: user.adresse ?? "",
      complement: user.complement ?? "",
      cp: user.cp ?? "",
      ville: user.ville ?? "",
      naissance: user.naissance ?? null,
    },

    payment: {
      default_payment_method_id:
        user.default_payment_method_id ??
        user.stripe_default_payment_method_id ??
        null,

      card: user.card_last4
        ? {
            id:
              user.default_payment_method_id ??
              user.stripe_default_payment_method_id ??
              null,
            brand: user.card_brand ?? null,
            last4: user.card_last4 ?? null,
            exp_month: user.card_exp_month ?? null,
            exp_year: user.card_exp_year ?? null,
          }
        : null,
    },
  };
}

/* =========================================================
   GET /api/me
========================================================= */

router.get("/api/me", authMiddleware, async (req, res) => {
  try {
    const userId = req.userId;

    if (!userId) {
      return res.status(401).json({ error: "Utilisateur non authentifié" });
    }

    const user = await getUserById(userId);

    if (!user) {
      return res.status(404).json({ error: "Utilisateur introuvable" });
    }

    return res.json(normalizeUserResponse(user));
  } catch (error) {
    console.error("Erreur GET /api/me :", error);
    return res.status(500).json({ error: "Erreur serveur" });
  }
});

/* =========================================================
   POST /api/me
========================================================= */

router.post("/api/me", authMiddleware, async (req, res) => {
  try {
    const userId = req.userId;

    if (!userId) {
      return res.status(401).json({ error: "Utilisateur non authentifié" });
    }

    const body = req.body || {};

    const payload = {
      prenom: safeText(body.prenom, 80),
      nom: safeText(body.nom, 80),
      telephone: safeText(body.telephone, 40),
      pays: safeCountry(body.pays),
      adresse: safeText(body.adresse, 160),
      complement: safeText(body.complement, 160),
      cp: safeText(body.cp, 20),
      ville: safeText(body.ville, 80),
      naissance: safeBirthdate(body.naissance),
    };

    if (typeof body.email === "string" && body.email.trim()) {
      payload.email = safeEmail(body.email);
    }

    const updatedUser = await updateUserById(userId, payload);

    if (!updatedUser) {
      return res.status(404).json({ error: "Utilisateur introuvable" });
    }

    return res.json({
      success: true,
      user: normalizeUserResponse(updatedUser),
    });
  } catch (error) {
    console.error("Erreur POST /api/me :", error);
    return res.status(500).json({ error: "Erreur serveur" });
  }
});

export default router;