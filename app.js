// backend/app.js

import express from "express";
import cors from "cors";
import bodyParser from "body-parser";
import helmet from "helmet";
import rateLimit from "express-rate-limit";

import webhookRoutes from "./routes/webhookRoutes.js";
import healthRoutes from "./routes/healthRoutes.js";
import publicRoutes from "./routes/publicRoutes.js";
import authRoutes from "./routes/authRoutes.js";
import userRoutes from "./routes/userRoutes.js";
import paymentRoutes from "./routes/paymentRoutes.js";
import reservationRoutes from "./routes/reservationRoutes.js";
import reviewRoutes from "./routes/reviewRoutes.js";
import adminRoutes from "./routes/adminRoutes.js";

const app = express();

/**
 * ORIGINES AUTORISÉES
 * Mets ici :
 * - ton domaine Vercel réel
 * - ton domaine custom si tu en as un
 * - localhost pour le dev
 */
const allowedOrigins = [
  "https://site-reservation-qr.vercel.app",
  "https://site-reservation-qr-git-main.vercel.app",
  "http://localhost:3000",
  "http://127.0.0.1:5500",
  "http://localhost:5500",
];

/**
 * Si tu as des previews Vercel dynamiques,
 * on autorise aussi les sous-domaines vercel.app
 * du projet Singbox uniquement.
 */
function isAllowedOrigin(origin) {
  if (!origin) return true; // autorise Postman, cron, serveur à serveur
  if (allowedOrigins.includes(origin)) return true;

  try {
    const url = new URL(origin);
    const hostname = url.hostname.toLowerCase();

    // autorise les previews Vercel du projet
    if (
      hostname.endsWith(".vercel.app") &&
      hostname.includes("site-reservation-qr")
    ) {
      return true;
    }

    return false;
  } catch {
    return false;
  }
}

const corsOptions = {
  origin(origin, callback) {
    if (isAllowedOrigin(origin)) {
      return callback(null, true);
    }
    return callback(new Error("Origine non autorisée par CORS"));
  },
  methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization", "x-cron-secret"],
  credentials: false,
};

app.set("trust proxy", 1);

/**
 * HEADERS DE SÉCURITÉ
 */
app.use(
  helmet({
    crossOriginResourcePolicy: false,
  })
);

/**
 * CORS
 */
app.use(cors(corsOptions));
app.options("*", cors(corsOptions));

console.log("🌍 CORS configuré avec liste blanche");

/**
 * RATE LIMITS
 */
const globalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 min
  max: 300,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Trop de requêtes. Réessaie plus tard." },
});

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Trop de tentatives de connexion. Réessaie plus tard." },
});

const paymentLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Trop de tentatives de paiement/réservation. Réessaie plus tard." },
});

const guestLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 40,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Trop de tentatives sur les liens invités. Réessaie plus tard." },
});

const adminLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 80,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Trop de requêtes admin. Réessaie plus tard." },
});

app.use(globalLimiter);

/**
 * Important : webhook avant bodyParser.json()
 */
app.use(webhookRoutes);

/**
 * JSON PARSER
 */
app.use(bodyParser.json({ limit: "1mb" }));

console.log("🌍 Sécurité HTTP + CORS + JSON configurés");

/**
 * ROUTES PUBLIQUES / SANTÉ
 */
app.use(healthRoutes);
app.use(publicRoutes);

/**
 * ROUTES SENSIBLES PAR FAMILLE
 */
app.use(authLimiter, authRoutes);
app.use(userRoutes);
app.use(paymentLimiter, paymentRoutes);
app.use(paymentLimiter, reservationRoutes);
app.use(guestLimiter, reviewRoutes);
app.use(adminLimiter, adminRoutes);

/**
 * HANDLER ERREURS CORS
 */
app.use((err, req, res, next) => {
  if (err && String(err.message || "").includes("CORS")) {
    return res.status(403).json({ error: "Origine non autorisée" });
  }
  return next(err);
});

/**
 * HANDLER ERREURS GÉNÉRAL
 */
app.use((err, req, res, next) => {
  console.error("❌ Erreur serveur non gérée :", err);
  return res.status(500).json({ error: "Erreur serveur interne" });
});

export default app;