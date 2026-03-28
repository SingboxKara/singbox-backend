// backend/app.js

import express from "express";
import cors from "cors";
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
import chestRoutes from "./routes/chestRoutes.js";
import passRoutes from "./routes/passRoutes.js";

const app = express();

app.disable("x-powered-by");

/* =========================================================
   ORIGINES AUTORISÉES
========================================================= */

const STATIC_ALLOWED_ORIGINS = [
  "https://www.singbox.fr",
  "https://singbox.fr",
  "https://site-reservation-qr.vercel.app",
  "https://site-reservation-qr-git-main.vercel.app",
  "http://localhost:3000",
  "http://127.0.0.1:3000",
  "http://localhost:5500",
  "http://127.0.0.1:5500",
];

function normalizeOrigin(origin) {
  return String(origin || "").trim();
}

function isLocalDevOrigin(url) {
  const hostname = String(url.hostname || "").toLowerCase();
  return hostname === "localhost" || hostname === "127.0.0.1";
}

function isAllowedOrigin(origin) {
  const safeOrigin = normalizeOrigin(origin);

  if (!safeOrigin) return true;

  if (STATIC_ALLOWED_ORIGINS.includes(safeOrigin)) {
    return true;
  }

  try {
    const url = new URL(safeOrigin);
    const hostname = String(url.hostname || "").toLowerCase();
    const protocol = String(url.protocol || "").toLowerCase();

    if (protocol !== "https:" && protocol !== "http:") {
      return false;
    }

    if (hostname === "www.singbox.fr" || hostname === "singbox.fr") {
      return true;
    }

    if (
      hostname.endsWith(".vercel.app") &&
      hostname.includes("site-reservation-qr")
    ) {
      return true;
    }

    if (protocol === "http:" && isLocalDevOrigin(url)) {
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

    return callback(new Error(`Origine non autorisée par CORS: ${origin}`));
  },
  methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  allowedHeaders: [
    "Content-Type",
    "Authorization",
    "X-Requested-With",
    "x-cron-secret",
  ],
  credentials: true,
  optionsSuccessStatus: 204,
};

/* =========================================================
   PROXY / IP
========================================================= */

app.set("trust proxy", 1);

/* =========================================================
   HEADERS DE SÉCURITÉ
========================================================= */

app.use(
  helmet({
    crossOriginResourcePolicy: false,
    crossOriginEmbedderPolicy: false,
    contentSecurityPolicy: {
      useDefaults: true,
      directives: {
        defaultSrc: ["'self'"],

        scriptSrc: [
          "'self'",
          "'unsafe-inline'",
          "https://js.stripe.com",
          "https://cdn.jsdelivr.net",
        ],

        styleSrc: [
          "'self'",
          "'unsafe-inline'",
          "https://fonts.googleapis.com",
          "https://cdn.jsdelivr.net",
        ],

        imgSrc: ["'self'", "data:", "blob:", "https:"],

        fontSrc: ["'self'", "data:", "https://fonts.gstatic.com"],

        connectSrc: [
          "'self'",
          "https://www.singbox.fr",
          "https://singbox.fr",
          "https://site-reservation-qr.vercel.app",
          "https://site-reservation-qr-git-main.vercel.app",
          "https://singbox-backend.onrender.com",
          "https://api.stripe.com",
          "https://js.stripe.com",
          "https://cdn.jsdelivr.net",
          "https://*.supabase.co",
          "wss://*.supabase.co",
          "https://api.web3forms.com",
          "https://hcaptcha.com",
          "https://*.hcaptcha.com",
          "https://www.google.com",
          "https://maps.googleapis.com",
          "https://maps.google.com",
          "https://www.gstatic.com",
        ],

        frameSrc: [
          "'self'",
          "https://js.stripe.com",
          "https://hooks.stripe.com",
          "https://hcaptcha.com",
          "https://*.hcaptcha.com",
          "https://www.google.com",
        ],

        objectSrc: ["'none'"],
        baseUri: ["'self'"],
        formAction: ["'self'"],
      },
    },
  })
);

/* =========================================================
   CORS
========================================================= */

app.use(cors(corsOptions));
app.options("*", cors(corsOptions));

console.log("✅ CORS configuré avec liste blanche");

/* =========================================================
   HELPERS RATE LIMIT
========================================================= */

function normalizeIp(ip) {
  const value = String(ip || "").trim();

  if (!value) return "unknown";

  if (value === "::1") return "127.0.0.1";
  if (value.startsWith("::ffff:")) return value.replace("::ffff:", "");

  return value;
}

function getClientIp(req) {
  const xForwardedFor = req.headers["x-forwarded-for"];

  if (typeof xForwardedFor === "string" && xForwardedFor.trim()) {
    return normalizeIp(xForwardedFor.split(",")[0].trim());
  }

  if (Array.isArray(xForwardedFor) && xForwardedFor.length > 0) {
    return normalizeIp(String(xForwardedFor[0] || "").split(",")[0].trim());
  }

  return normalizeIp(
    req.ip || req.socket?.remoteAddress || req.connection?.remoteAddress || "unknown"
  );
}

function buildLimiter({
  name,
  windowMs,
  max,
  message,
  skipSuccessfulRequests = false,
  skip: customSkip,
}) {
  return rateLimit({
    windowMs,
    max,
    standardHeaders: true,
    legacyHeaders: false,
    skipSuccessfulRequests,
    skip: (req) => {
      if (req.method === "OPTIONS") return true;
      if (typeof customSkip === "function" && customSkip(req)) return true;
      return false;
    },
    keyGenerator: (req) => {
      const ip = getClientIp(req);
      return `${name}:${ip}`;
    },
    handler: (req, res) => {
      const payload = {
        error: message,
        limiter: name,
        path: req.originalUrl || req.url || null,
      };

      console.warn("⛔ Rate limit déclenché :", payload);
      return res.status(429).json(payload);
    },
  });
}

/* =========================================================
   RATE LIMITS
========================================================= */

const globalLimiter = buildLimiter({
  name: "global",
  windowMs: 15 * 60 * 1000,
  max: 1200,
  message: "Trop de requêtes. Réessaie plus tard.",
  skip: (req) => {
    const path = req.originalUrl || req.url || "";
    return (
      path.startsWith("/health") ||
      path.startsWith("/api/health") ||
      path.startsWith("/webhook") ||
      path.startsWith("/api/webhook")
    );
  },
});

const authLimiter = buildLimiter({
  name: "auth",
  windowMs: 15 * 60 * 1000,
  max: 30,
  message: "Trop de tentatives de connexion. Réessaie plus tard.",
  skipSuccessfulRequests: true,
});

const paymentLimiter = buildLimiter({
  name: "payment",
  windowMs: 15 * 60 * 1000,
  max: 120,
  message: "Trop de tentatives de paiement/réservation. Réessaie plus tard.",
});

const chestLimiter = buildLimiter({
  name: "chest",
  windowMs: 15 * 60 * 1000,
  max: 180,
  message: "Trop de requêtes coffre. Réessaie plus tard.",
});

const guestLimiter = buildLimiter({
  name: "guest",
  windowMs: 15 * 60 * 1000,
  max: 80,
  message: "Trop de tentatives sur les liens invités. Réessaie plus tard.",
});

const adminLimiter = buildLimiter({
  name: "admin",
  windowMs: 15 * 60 * 1000,
  max: 120,
  message: "Trop de requêtes admin. Réessaie plus tard.",
});

app.use(globalLimiter);

/* =========================================================
   WEBHOOK AVANT PARSER JSON
========================================================= */

app.use(webhookRoutes);

/* =========================================================
   PARSERS BODY
========================================================= */

app.use(
  express.json({
    limit: "1mb",
    strict: true,
  })
);

app.use(
  express.urlencoded({
    extended: true,
    limit: "1mb",
  })
);

console.log("✅ Sécurité HTTP + CORS + JSON configurés");

/* =========================================================
   ROUTES PUBLIQUES / SANTÉ
========================================================= */

app.use(healthRoutes);
app.use(publicRoutes);

/* =========================================================
   ROUTES SENSIBLES PAR FAMILLE
========================================================= */

app.use(authLimiter, authRoutes);
app.use(userRoutes);
app.use(paymentLimiter, paymentRoutes);
app.use(paymentLimiter, reservationRoutes);
app.use(paymentLimiter, passRoutes);
app.use(chestLimiter, chestRoutes);
app.use(guestLimiter, reviewRoutes);
app.use(adminLimiter, adminRoutes);

/* =========================================================
   404
========================================================= */

app.use((req, res) => {
  return res.status(404).json({
    error: "Route introuvable",
    path: req.originalUrl || req.url || null,
  });
});

/* =========================================================
   HANDLER ERREURS CORS / JSON / GLOBAL
========================================================= */

app.use((err, req, res, next) => {
  if (res.headersSent) {
    return next(err);
  }

  const message = String(err?.message || "");

  if (message.includes("CORS")) {
    return res.status(403).json({ error: "Origine non autorisée" });
  }

  if (err?.type === "entity.parse.failed") {
    return res.status(400).json({ error: "JSON invalide" });
  }

  if (err?.type === "entity.too.large") {
    return res.status(413).json({ error: "Requête trop volumineuse" });
  }

  console.error("❌ Erreur serveur non gérée :", err);

  return res.status(err?.status || 500).json({
    error:
      err?.status && err.status < 500
        ? err.message || "Erreur requête"
        : "Erreur serveur interne",
  });
});

export default app;
