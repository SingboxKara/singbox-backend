// backend/server.js

import express from "express";
import cors from "cors";
import bodyParser from "body-parser";
import Stripe from "stripe";
import { createClient } from "@supabase/supabase-js";
import dotenv from "dotenv";
import { Resend } from "resend";
import QRCode from "qrcode";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";

dotenv.config(); // lit le fichier .env en local

// ---------- CONFIG ENV ----------
const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY;
const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET;

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const RESEND_API_KEY = process.env.RESEND_API_KEY;

if (!STRIPE_SECRET_KEY) {
  console.error("❌ STRIPE_SECRET_KEY manquante dans .env");
}
if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.warn(
    "⚠️ SUPABASE_URL ou SUPABASE_SERVICE_ROLE_KEY manquantes dans .env (réservations non actives)"
  );
}
if (!RESEND_API_KEY) {
  console.warn(
    "⚠️ RESEND_API_KEY manquante : l'envoi d'email sera désactivé (pas de mails de confirmation)"
  );
}
if (!STRIPE_WEBHOOK_SECRET) {
  console.warn(
    "⚠️ STRIPE_WEBHOOK_SECRET manquant : les webhooks Stripe ne seront pas vérifiés"
  );
}

// ---------- INIT CLIENTS ----------
const stripe = STRIPE_SECRET_KEY
  ? new Stripe(STRIPE_SECRET_KEY, {
      apiVersion: "2023-10-16",
    })
  : null;

const supabase =
  SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY
    ? createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)
    : null;

// Mail via Resend
const mailEnabled = !!RESEND_API_KEY;
const resend = mailEnabled ? new Resend(RESEND_API_KEY) : null;

const app = express();

// CORS : tu peux mettre l’URL exacte de ton front à la place de "*"
app.use(
  cors({
    origin: "*",
  })
);

console.log("🌍 CORS autorise l'origine : *");

// Prix par créneau de secours (si jamais le slot n'a pas de price)
const PRICE_PER_SLOT_EUR = 10;

// Montant de la caution (empreinte bancaire) en euros
const DEPOSIT_AMOUNT_EUR = 250;

// Durée d’un créneau en minutes (1h30)
const SLOT_DURATION_MINUTES = 90;

// ------------------------------------------------------
// Vacances scolaires (Zone C : Toulouse) - à ajuster chaque année
// ------------------------------------------------------
const VACANCES_ZONE_C = [
  // Année scolaire 2024-2025 (exemple, à adapter si besoin)
  { start: "2025-10-19", end: "2025-11-03", label: "Toussaint 2024" },
  { start: "2025-12-21", end: "2026-01-05", label: "Noël 2024" },
  { start: "2026-02-22", end: "2026-03-09", label: "Hiver 2025" },
  { start: "2026-04-19", end: "2026-05-04", label: "Printemps 2025" },
  // Été : on considère juillet/août comme vacances scolaires
  { start: "2026-07-05", end: "2026-09-01", label: "Été 2025" },
];

// Helper : savoir si une date ISO est dans [start, end] (inclus)
function isDateInRange(isoDate, start, end) {
  return isoDate >= start && isoDate <= end;
}

// ------------------------------------------------------
// Helpers
// ------------------------------------------------------

// total du panier en € (en priorité slot.price)
function computeCartTotalEur(panier) {
  return panier.reduce((sum, item) => {
    const price =
      typeof item.price === "number" && !Number.isNaN(item.price)
        ? item.price
        : PRICE_PER_SLOT_EUR;
    return sum + price;
  }, 0);
}

// Valide un code promo + calcule la remise
async function validatePromoCode(code, totalAmountEur) {
  if (!supabase) {
    return { ok: false, reason: "Supabase non configuré" };
  }
  if (!code) {
    return { ok: false, reason: "Code vide" };
  }

  const upperCode = String(code).trim().toUpperCase();

  const { data: promo, error } = await supabase
    .from("promo_codes")
    .select("*")
    .eq("code", upperCode)
    .single();

  if (error || !promo) {
    console.warn("Promo introuvable :", error);
    return { ok: false, reason: "Code introuvable" };
  }

  // is_active (bool) si tu l'as créé
  if (promo.is_active === false) {
    return { ok: false, reason: "Code inactif" };
  }

  const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD

  if (promo.valid_from && today < promo.valid_from) {
    return { ok: false, reason: "Code pas encore valable" };
  }
  if (promo.valid_to && today > promo.valid_to) {
    return { ok: false, reason: "Code expiré" };
  }

  if (promo.max_uses && promo.used_count >= promo.max_uses) {
    return { ok: false, reason: "Nombre d'utilisations atteint" };
  }

  let discountAmount = 0;
  const type = promo.type; // "percent" | "fixed" | "free"
  const value = Number(promo.value) || 0;

  if (type === "percent") {
    discountAmount = Math.round(totalAmountEur * (value / 100));
  } else if (type === "fixed") {
    discountAmount = Math.min(totalAmountEur, value);
  } else if (type === "free") {
    discountAmount = totalAmountEur;
  } else {
    // type inconnu -> pas de remise
    discountAmount = 0;
  }

  const newTotal = Math.max(0, totalAmountEur - discountAmount);

  return {
    ok: true,
    newTotal,
    discountAmount,
    promo,
  };
}

// Ajoute des jours à une date ISO (YYYY-MM-DD)
function addDaysToDateString(dateStr, daysToAdd) {
  const [y, m, d] = dateStr.split("-").map((x) => parseInt(x, 10));
  const base = new Date(Date.UTC(y, m - 1, d));
  base.setUTCDate(base.getUTCDate() + daysToAdd);
  const ny = base.getUTCFullYear();
  const nm = String(base.getUTCMonth() + 1).padStart(2, "0");
  const nd = String(base.getUTCDate()).padStart(2, "0");
  return `${ny}-${nm}-${nd}`;
}

/**
 * Construit start_time / end_time à partir du slot.
 * Désormais : durée par défaut = SLOT_DURATION_MINUTES (1h30).
 */
function buildTimesFromSlot(slot) {
  // Cas 1 : start_time / end_time déjà fournis
  if (slot.start_time && slot.end_time) {
    const dateFromStart = slot.date || String(slot.start_time).slice(0, 10);
    return {
      start_time: slot.start_time,
      end_time: slot.end_time,
      date: dateFromStart,
      datetime: slot.start_time,
    };
  }

  // Cas 2 : on part de date + hour
  const date = slot.date; // "YYYY-MM-DD"
  const rawHour = slot.hour; // 21, "21", "21h-22h", "18h30", ...

  if (!date || rawHour === undefined || rawHour === null) {
    throw new Error(
      "Slot incomplet : date / hour ou start_time / end_time manquants"
    );
  }

  let hourNum = 0;
  let minuteNum = 0;

  if (typeof rawHour === "number") {
    // 18      -> 18h00
    // 18.5    -> 18h30 (si un jour tu l'utilises)
    hourNum = Math.floor(rawHour);
    minuteNum = Math.round((rawHour - hourNum) * 60);
  } else {
    // gère "18h", "18:00", "18h30", "18h-19h30" → on prend l'heure de début
    const m = String(rawHour).match(/(\d{1,2})[h:]?(\d{2})?/);
    if (m) {
      hourNum = parseInt(m[1], 10);
      minuteNum = m[2] ? parseInt(m[2], 10) : 0;
    }
  }

  // Fuseau (simple) : à adapter si tu veux gérer l'heure d'été/ hiver dynamiquement
  const OFFSET = "+01:00";

  // start
  const startHourStr = String(hourNum).padStart(2, "0");
  const startMinStr = String(minuteNum).padStart(2, "0");
  const startIso = `${date}T${startHourStr}:${startMinStr}:00${OFFSET}`;

  // end = start + SLOT_DURATION_MINUTES (90 min)
  const totalStartMinutes = hourNum * 60 + minuteNum + SLOT_DURATION_MINUTES;
  const minutesPerDay = 24 * 60;

  const endDayOffset = Math.floor(totalStartMinutes / minutesPerDay);
  const minutesOfDay = totalStartMinutes % minutesPerDay;

  const endHour = Math.floor(minutesOfDay / 60);
  const endMinute = minutesOfDay % 60;

  const endDateStr =
    endDayOffset === 0 ? date : addDaysToDateString(date, endDayOffset);

  const endHourStr = String(endHour).padStart(2, "0");
  const endMinStr = String(endMinute).padStart(2, "0");
  const endIso = `${endDateStr}T${endHourStr}:${endMinStr}:00${OFFSET}`;

  return {
    start_time: startIso,
    end_time: endIso,
    date,
    datetime: startIso,
  };
}

// Envoi d'email avec QR code pour une réservation (via Resend)
async function sendReservationEmail(reservation) {
  if (!mailEnabled || !resend) {
    console.warn(
      "📧 Envoi mail désactivé (RESEND_API_KEY manquante) – email non envoyé."
    );
    return;
  }

  const toEmail = reservation.email;
  if (!toEmail) {
    console.warn(
      "📧 Impossible d'envoyer l'email : pas d'adresse sur la réservation",
      reservation.id
    );
    return;
  }

  try {
    const qrText = reservation.id;

    // 1) Génère une data URL directement utilisable dans <img src="...">
    const qrDataUrl = await QRCode.toDataURL(qrText);
    // Pour l'attachement, on garde juste le base64
    const base64Data = qrDataUrl.split(",")[1];

    const start = reservation.start_time
      ? new Date(reservation.start_time)
      : null;
    const end = reservation.end_time ? new Date(reservation.end_time) : null;

    const fmt = (d) =>
      d
        ? d.toLocaleString("fr-FR", {
            timeZone: "Europe/Paris",
            day: "2-digit",
            month: "2-digit",
            year: "numeric",
            hour: "2-digit",
            minute: "2-digit",
          })
        : "N/A";

    const startStr = fmt(start);
    const endStr = fmt(end);

    const subject = `🎤 Confirmation de votre réservation Singbox - Box ${reservation.box_id}`;

    const htmlBody = `
      <div style="margin:0;padding:24px 0;background-color:#050814;">
        <div style="max-width:640px;margin:0 auto;background:radial-gradient(circle at 0% 0%,rgba(56,189,248,0.12),transparent 55%),radial-gradient(circle at 100% 0%,rgba(201,76,53,0.25),transparent 55%),#020617;border-radius:18px;border:1px solid rgba(148,163,184,0.3);box-shadow:0 18px 45px rgba(0,0,0,0.85);padding:24px 22px 26px;font-family:'Montserrat',system-ui,-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:#F9FAFB;">
          
          <!-- HEADER -->
          <table width="100%" cellpadding="0" cellspacing="0" role="presentation" style="border-collapse:collapse;margin-bottom:18px;">
            <tr>
              <td style="vertical-align:middle;">
                <div style="display:flex;align-items:center;gap:10px;">
                  <!-- IMPORTANT : logo en HTTPS absolu -->
                  <img src="https://www.singbox.fr/logo.png" alt="Logo Singbox" width="72" height="72" style="border-radius:999px;display:block;box-shadow:0 0 20px rgba(201,76,53,0.65);" />
                  <div>
                    <div style="font-family:'League Spartan','Montserrat',system-ui,sans-serif;font-weight:700;letter-spacing:0.18em;text-transform:uppercase;font-size:18px;line-height:1.2;">Singbox</div>
                    <div style="font-size:12px;color:#9CA3AF;margin-top:2px;">Karaoké box privatives · Toulouse</div>
                  </div>
                </div>
              </td>
              <td align="right" style="vertical-align:middle;">
                <span style="display:inline-block;padding:6px 14px;border-radius:999px;background:rgba(15,23,42,0.85);border:1px solid rgba(148,163,184,0.45);font-size:11px;text-transform:uppercase;letter-spacing:0.12em;color:#E5E7EB;">
                  Confirmation de réservation
                </span>
              </td>
            </tr>
          </table>

          <!-- TITRE -->
          <h1 style="margin:0 0 8px 0;font-family:'League Spartan','Montserrat',system-ui,sans-serif;font-size:22px;letter-spacing:0.06em;text-transform:uppercase;">
            Votre session est confirmée ✅
          </h1>
          <p style="margin:0 0 14px 0;font-size:14px;color:rgba(249,250,251,0.88);line-height:1.6;">
            Merci pour votre réservation chez <strong>Singbox</strong> !
            Voici le récapitulatif de votre box karaoké privative.
          </p>

          <!-- CARTE RÉCAP -->
          <div style="margin:14px 0 16px 0;padding:14px 14px 12px 14px;border-radius:16px;background:rgba(15,23,42,0.92);border:1px solid rgba(148,163,184,0.45);">
            <table width="100%" cellpadding="0" cellspacing="0" role="presentation" style="border-collapse:collapse;">
              <tr>
                <td style="font-size:13px;color:#9CA3AF;padding-bottom:6px;">
                  Box réservée
                </td>
                <td style="font-size:13px;color:#9CA3AF;padding-bottom:6px;" align="right">
                  Horaires
                </td>
              </tr>
              <tr>
                <td style="font-size:15px;font-weight:600;">
                  Box ${reservation.box_id}
                </td>
                <td style="font-size:14px;" align="right">
                  ${startStr} → ${endStr}
                </td>
              </tr>
            </table>
            <p style="margin:10px 0 4px 0;font-size:13px;color:#E5E7EB;">
              <strong>Merci d'arriver 10 minutes en avance</strong> afin de pouvoir vous installer et démarrer la session à l'heure.
            </p>
          </div>

          <!-- QR CODE -->
          <div style="text-align:center;margin:18px 0 8px 0;">
            <p style="margin:0 0 8px 0;font-size:13px;color:#9CA3AF;">
              Présentez ce QR code à votre arrivée pour accéder à votre box :
            </p>
            <!-- On utilise directement la data URL ici -->
            <img src="${qrDataUrl}" alt="QR Code Singbox" style="max-width:220px;height:auto;border-radius:18px;box-shadow:0 14px 30px rgba(0,0,0,0.9);" />
          </div>

          <!-- EMPREINTE BANCAIRE -->
          <div style="margin-top:18px;padding:14px 14px 12px 14px;border-radius:16px;background:rgba(24,24,27,0.96);border:1px solid rgba(248,113,113,0.45);">
            <h2 style="margin:0 0 6px 0;font-size:15px;font-family:'League Spartan','Montserrat',system-ui,sans-serif;letter-spacing:0.06em;text-transform:uppercase;color:#fecaca;">
              Empreinte bancaire de ${DEPOSIT_AMOUNT_EUR} €
            </h2>
            <p style="margin:0 0 6px 0;font-size:13px;color:#E5E7EB;">
              Pour garantir le bon déroulement de la session, une <strong>empreinte bancaire de ${DEPOSIT_AMOUNT_EUR} €</strong> peut être réalisée sur votre carte bancaire.
            </p>
            <ul style="margin:6px 0 6px 18px;padding:0;font-size:12px;color:#E5E7EB;">
              <li>Il ne s'agit <strong>pas d'un débit immédiat</strong>, mais d'un blocage temporaire du montant.</li>
              <li>L'empreinte n'est <strong>pas encaissée</strong> si la session se déroule normalement et que le règlement est respecté.</li>
              <li>En cas de dégradations ou non-respect des règles, tout ou partie de ce montant peut être prélevé après constat par l'équipe Singbox.</li>
            </ul>
            <p style="margin:0;font-size:11px;color:#9CA3AF;">
              Les délais de libération de l’empreinte dépendent de votre banque (généralement quelques jours).
            </p>
          </div>

          <!-- CONDITIONS D'ANNULATION -->
          <div style="margin-top:18px;">
            <h2 style="margin:0 0 6px 0;font-size:15px;font-family:'League Spartan','Montserrat',system-ui,sans-serif;letter-spacing:0.06em;text-transform:uppercase;">
              Conditions d'annulation
            </h2>
            <ul style="margin:6px 0 0 18px;padding:0;font-size:13px;color:#E5E7EB;">
              <li>Annulation gratuite jusqu'à <strong>24h avant</strong> le début de la session.</li>
              <li>Passé ce délai, la réservation est considérée comme due et <strong>non remboursable</strong>.</li>
              <li>En cas de retard important, la session pourra être écourtée sans compensation afin de respecter les créneaux suivants.</li>
            </ul>
          </div>

          <!-- REGLEMENT INTERIEUR -->
          <div style="margin-top:18px;">
            <h2 style="margin:0 0 6px 0;font-size:15px;font-family:'League Spartan','Montserrat',system-ui,sans-serif;letter-spacing:0.06em;text-transform:uppercase;">
              Règlement intérieur Singbox
            </h2>
            <ul style="margin:6px 0 0 18px;padding:0;font-size:13px;color:#E5E7EB;">
              <li><strong>Respect du matériel</strong> : micros, écrans, banquettes et équipements doivent être utilisés avec soin.</li>
              <li><strong>Comportement</strong> : toute attitude violente, insultante ou dangereuse peut entraîner l'arrêt immédiat de la session.</li>
              <li><strong>Alcool & drogues</strong> : l'accès pourra être refusé en cas d'état d'ébriété avancé ou de consommation de substances illicites.</li>
              <li><strong>Fumée</strong> : il est strictement interdit de fumer ou vapoter dans les box.</li>
              <li><strong>Nuisances sonores</strong> : merci de respecter les autres clients et le voisinage dans les espaces communs.</li>
              <li><strong>Capacité maximale</strong> : le nombre de personnes par box ne doit pas dépasser la limite indiquée sur place.</li>
            </ul>
            <p style="margin:8px 0 0 0;font-size:11px;color:#9CA3AF;">
              En validant votre réservation, vous acceptez le règlement intérieur de Singbox.
            </p>
          </div>

          <!-- INFOS PRATIQUES -->
          <div style="margin-top:20px;">
            <h2 style="margin:0 0 6px 0;font-size:15px;font-family:'League Spartan','Montserrat',system-ui,sans-serif;letter-spacing:0.06em;text-transform:uppercase;">
              Infos pratiques
            </h2>
            <p style="margin:0 0 4px 0;font-size:13px;color:#E5E7EB;">
              Adresse : <strong>66 Rue de la République, 31300 Toulouse</strong> (à adapter si besoin).
            </p>
            <p style="margin:0 0 4px 0;font-size:13px;color:#9CA3AF;">
              Pensez à vérifier l'accès et le stationnement avant votre venue.
            </p>
          </div>

          <!-- FOOTER -->
          <div style="margin-top:22px;padding-top:10px;border-top:1px solid rgba(30,64,175,0.65);font-size:11px;color:#9CA3AF;text-align:center;">
            Suivez-nous sur Instagram et TikTok : <strong>@singboxtoulouse</strong><br/>
            Conservez cet e-mail, il vous sera demandé à l'arrivée.
          </div>
        </div>
      </div>
    `;

    console.log(
      "📧 Envoi de l'email (Resend) à",
      toEmail,
      "pour réservation",
      reservation.id
    );

    await resend.emails.send({
      from: "Singbox <onboarding@resend.dev>",
      to: toEmail,
      subject,
      html: htmlBody,
      // on garde le QR aussi en pièce jointe si la personne veut le télécharger
      attachments: [
        {
          filename: "qr-reservation.png",
          content: base64Data,
          contentType: "image/png",
        },
      ],
    });

    console.log(
      "✅ Email envoyé via Resend à",
      toEmail,
      "pour réservation",
      reservation.id
    );
  } catch (err) {
    console.error("❌ Erreur lors de l'envoi de l'email via Resend :", err);
  }
}

// ------------------------------------------------------
// Middleware d'authentification JWT
// ------------------------------------------------------
function authMiddleware(req, res, next) {
  const authHeader = req.headers.authorization;
  const token = authHeader?.startsWith("Bearer ")
    ? authHeader.split(" ")[1]
    : null;

  if (!token) {
    return res.status(401).json({ error: "Token manquant" });
  }

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    req.userId = decoded.userId;
    next();
  } catch (err) {
    console.error("JWT erreur :", err);
    return res.status(401).json({ error: "Token invalide" });
  }
}

// ------------------------------------------------------
// WEBHOOK STRIPE
// ------------------------------------------------------
app.post(
  "/api/webhook",
  bodyParser.raw({ type: "application/json" }),
  async (req, res) => {
    if (!stripe || !STRIPE_WEBHOOK_SECRET) {
      console.error(
        "❌ Webhook Stripe reçu mais STRIPE ou STRIPE_WEBHOOK_SECRET non configurés"
      );
      return res.status(500).send("Webhook non configuré");
    }

    const sig = req.headers["stripe-signature"];

    let event;
    try {
      event = stripe.webhooks.constructEvent(
        req.body,
        sig,
        STRIPE_WEBHOOK_SECRET
      );
    } catch (err) {
      console.error("❌ Erreur vérification signature webhook :", err.message);
      return res.status(400).send(`Webhook Error: ${err.message}`);
    }

    console.log("📩 Webhook Stripe reçu :", event.type);

    switch (event.type) {
      case "payment_intent.succeeded": {
        const paymentIntent = event.data.object;
        console.log(
          "✅ payment_intent.succeeded :",
          paymentIntent.id,
          "montant",
          paymentIntent.amount,
          "client",
          paymentIntent.metadata?.customer_email
        );
        break;
      }
      case "payment_intent.payment_failed": {
        const paymentIntent = event.data.object;
        console.warn(
          "⚠️ payment_intent.payment_failed :",
          paymentIntent.id,
          paymentIntent.last_payment_error?.message
        );
        break;
      }
      default:
        console.log(`ℹ️ Événement Stripe non géré : ${event.type}`);
    }

    res.json({ received: true });
  }
);

app.use(bodyParser.json());

console.log("🌍 CORS + JSON configurés");

// ------------------------------------------------------
// Vérifier le panier avant paiement : /api/verify-cart
// ------------------------------------------------------
app.post("/api/verify-cart", async (req, res) => {
  try {
    if (!supabase) {
      return res.status(500).send("Supabase non configuré");
    }

    const { items } = req.body;

    if (!items || !Array.isArray(items) || items.length === 0) {
      return res.status(400).send("Panier vide ou invalide");
    }

    const normalizedItems = [];

    for (const slot of items) {
      // 1) Reconstruire date / start_time / end_time
      const times = buildTimesFromSlot(slot);

      // 2) Identifier la box comme dans /api/confirm-reservation
      const rawBox =
        slot.boxId ?? slot.box_id ?? slot.box ?? slot.boxName ?? 1;

      let numericBoxId = parseInt(String(rawBox).replace(/[^0-9]/g, ""), 10);
      if (!Number.isFinite(numericBoxId)) {
        numericBoxId = 1;
      }

      // 3) Vérifier s'il y a déjà une réservation qui chevauche ce créneau
      const { data: conflicts, error: conflictError } = await supabase
        .from("reservations")
        .select("id")
        .eq("box_id", numericBoxId)
        .lt("start_time", times.end_time)
        .gt("end_time", times.start_time);

      if (conflictError) {
        console.error(
          "Erreur vérification conflits /api/verify-cart :",
          conflictError
        );
        return res
          .status(500)
          .send("Erreur serveur lors de la vérification des créneaux");
      }

      if (conflicts && conflicts.length > 0) {
        return res
          .status(409)
          .send(
            `Le créneau ${times.date} pour la box ${numericBoxId} n'est plus disponible.`
          );
      }

      // 4) Normaliser le prix (si manquant)
      const price =
        typeof slot.price === "number" && !Number.isNaN(slot.price)
          ? slot.price
          : PRICE_PER_SLOT_EUR;

      normalizedItems.push({
        ...slot,
        price,
        box_id: numericBoxId,
        start_time: times.start_time,
        end_time: times.end_time,
        date: times.date,
      });
    }

    // Tout est OK → renvoie le panier éventuellement corrigé
    return res.json({ items: normalizedItems });
  } catch (e) {
    console.error("Erreur /api/verify-cart :", e);
    return res
      .status(500)
      .send("Erreur serveur lors de la vérification du panier");
  }
});

// ------------------------------------------------------
// AUTH - INSCRIPTION
// ------------------------------------------------------
app.post("/api/register", async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password)
      return res.status(400).json({ error: "Email et mot de passe requis" });

    if (!supabase) {
      return res.status(500).json({ error: "Supabase non configuré" });
    }

    const hash = await bcrypt.hash(password, 10);

    const { error } = await supabase
      .from("users")
      .insert({ email, password_hash: hash });

    if (error) {
      console.error(error);
      return res.status(400).json({ error: error.message });
    }

    res.json({ message: "Compte créé" });
  } catch (err) {
    console.error("Erreur register :", err);
    res.status(500).json({ error: "Erreur serveur" });
  }
});

// ------------------------------------------------------
// AUTH - LOGIN
// ------------------------------------------------------
app.post("/api/login", async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password)
      return res.status(400).json({ error: "Email et mot de passe requis" });

    if (!supabase) {
      return res.status(500).json({ error: "Supabase non configuré" });
    }

    const { data: users, error } = await supabase
      .from("users")
      .select("*")
      .eq("email", email)
      .limit(1);

    if (error) return res.status(400).json({ error: error.message });

    const user = users && users[0];
    if (!user) return res.status(400).json({ error: "Email inconnu" });

    const ok = await bcrypt.compare(password, user.password_hash);
    if (!ok) return res.status(400).json({ error: "Mot de passe incorrect" });

    const token = jwt.sign({ userId: user.id }, process.env.JWT_SECRET, {
      expiresIn: "7d",
    });

    res.json({ token });
  } catch (err) {
    console.error("Erreur login :", err);
    res.status(500).json({ error: "Erreur serveur" });
  }
});

// ------------------------------------------------------
// PROFIL UTILISATEUR
// ------------------------------------------------------
app.get("/api/me", authMiddleware, async (req, res) => {
  try {
    const userId = req.userId;

    if (!supabase) {
      return res.status(500).json({ error: "Supabase non configuré" });
    }

    const { data, error } = await supabase
      .from("users")
      .select("email, points")
      .eq("id", userId)
      .single();

    if (error) return res.status(400).json({ error: error.message });

    res.json(data);
  } catch (err) {
    console.error("Erreur me :", err);
    res.status(500).json({ error: "Erreur serveur" });
  }
});

// ------------------------------------------------------
// MES RÉSERVATIONS (pour la page "Mon compte")
// ------------------------------------------------------
app.get("/api/my-reservations", authMiddleware, async (req, res) => {
  try {
    if (!supabase) {
      return res.status(500).json({ error: "Supabase non configuré" });
    }

    const userId = req.userId;

    // On récupère l'email de l'utilisateur
    const { data: user, error: userError } = await supabase
      .from("users")
      .select("email")
      .eq("id", userId)
      .single();

    if (userError || !user) {
      console.error("Erreur lecture user pour my-reservations :", userError);
      return res.status(400).json({ error: "Utilisateur introuvable" });
    }

    // On filtre les réservations par email (pas besoin de colonne user_id)
    const { data: reservations, error } = await supabase
      .from("reservations")
      .select("*")
      .eq("email", user.email)
      .order("start_time", { ascending: false });

    if (error) {
      console.error("Erreur Supabase my-reservations :", error);
      return res
        .status(500)
        .json({ error: "Erreur en chargeant les réservations" });
    }

    return res.json({ reservations: reservations || [] });
  } catch (e) {
    console.error("Erreur /api/my-reservations :", e);
    return res.status(500).json({ error: "Erreur serveur" });
  }
});

// ------------------------------------------------------
// AJOUT DE POINTS FIDÉLITÉ
// ------------------------------------------------------
app.post("/api/add-points", authMiddleware, async (req, res) => {
  try {
    const userId = req.userId;
    const { points } = req.body;

    if (!points) {
      return res.status(400).json({ error: "Nombre de points manquant" });
    }

    if (!supabase) {
      return res.status(500).json({ error: "Supabase non configuré" });
    }

    const { error } = await supabase.rpc("increment_points", {
      user_id: userId,
      points_to_add: points,
    });

    if (error) {
      console.error(error);
      return res.status(400).json({ error: error.message });
    }

    res.json({ message: "Points ajoutés !" });
  } catch (err) {
    console.error("Erreur add-points :", err);
    res.status(500).json({ error: "Erreur serveur" });
  }
});

// ------------------------------------------------------
// UTILISER 100 POINTS FIDÉLITÉ → /api/use-loyalty
// ------------------------------------------------------
app.post("/api/use-loyalty", authMiddleware, async (req, res) => {
  try {
    const userId = req.userId;

    if (!supabase) {
      return res.status(500).json({ error: "Supabase non configuré" });
    }

    const { data: user, error } = await supabase
      .from("users")
      .select("points")
      .eq("id", userId)
      .single();

    if (error || !user) {
      return res.status(400).json({ error: "Utilisateur introuvable" });
    }

    if (user.points < 100) {
      return res.status(400).json({ error: "Pas assez de points" });
    }

    const { error: updateErr } = await supabase
      .from("users")
      .update({ points: user.points - 100 })
      .eq("id", userId);

    if (updateErr) {
      console.error(updateErr);
      return res.status(500).json({ error: "Impossible de retirer les points" });
    }

    return res.json({ success: true, message: "100 points utilisés" });
  } catch (e) {
    console.error("Erreur /api/use-loyalty :", e);
    return res.status(500).json({ error: "Erreur serveur" });
  }
});

// ------------------------------------------------------
// 0) Route de test
// ------------------------------------------------------
app.get("/", (req, res) => {
  res.send("API Singbox OK");
});

// ------------------------------------------------------
// 0bis) /api/is-vacances : indique si la date est en vacances scolaires
// ------------------------------------------------------
app.get("/api/is-vacances", (req, res) => {
  const date = req.query.date; // attendu: "YYYY-MM-DD"
  if (!date) {
    return res
      .status(400)
      .json({ error: "Paramètre 'date' manquant (YYYY-MM-DD)" });
  }

  const matchingPeriods = VACANCES_ZONE_C.filter((p) =>
    isDateInRange(date, p.start, p.end)
  );
  const isHoliday = matchingPeriods.length > 0;

  return res.json({
    vacances: isHoliday,
    is_vacances: isHoliday,
    zone: "C",
    date,
    periods: matchingPeriods,
  });
});

// ------------------------------------------------------
// 1) CRÉER UN PAYMENT INTENT STRIPE (paiement de la session)
// ------------------------------------------------------
app.post("/api/create-payment-intent", async (req, res) => {
  try {
    if (!stripe) {
      return res.status(500).json({ error: "Stripe non configuré" });
    }

    console.log("/api/create-payment-intent appelé");
    const { panier, customer, promoCode, finalAmountCents, loyaltyUsed } =
      req.body || {};

    if (!panier || !Array.isArray(panier) || panier.length === 0) {
      return res.status(400).json({ error: "Panier vide" });
    }

    // Base : total du panier
    const totalBeforeDiscount = computeCartTotalEur(panier);
    let totalAmountEur = totalBeforeDiscount;
    let discountAmount = 0;
    let promo = null;

    // 1) Applique le code promo côté serveur (source de vérité)
    if (promoCode) {
      const result = await validatePromoCode(promoCode, totalAmountEur);
      if (result.ok) {
        totalAmountEur = result.newTotal;
        discountAmount = result.discountAmount;
        promo = result.promo;
      } else {
        console.warn("Code promo non appliqué :", result.reason);
      }
    }

    // 2) Si la fidélité a été utilisée, on considère la séance comme 100 % gratuite
    if (loyaltyUsed) {
      console.log("⭐ Fidélité utilisée : séance gratuite côté backend.");
      discountAmount = totalBeforeDiscount;
      totalAmountEur = 0;
    }

    // 3) Si le front a envoyé finalAmountCents, on peut vérifier l'écart pour debug
    if (
      typeof finalAmountCents === "number" &&
      finalAmountCents >= 0 &&
      Number.isFinite(finalAmountCents)
    ) {
      const frontTotal = finalAmountCents / 100;
      if (Math.abs(frontTotal - totalAmountEur) > 0.01) {
        console.warn(
          "⚠️ Écart entre total front et back :",
          "front=",
          frontTotal,
          "back=",
          totalAmountEur
        );
      }
    }

    console.log(
      "Montant total calculé (après remise / fidélité) :",
      totalAmountEur,
      "€ ; remise=",
      discountAmount,
      "€"
    );

    // 4) Cas séance 100 % gratuite → on ne crée PAS de PaymentIntent Stripe
    if (totalAmountEur <= 0) {
      console.log("🟢 Séance gratuite : aucun PaymentIntent Stripe créé.");
      return res.json({
        isFree: true,
        totalBeforeDiscount,
        totalAfterDiscount: 0,
        discountAmount: totalBeforeDiscount,
        promo: promo
          ? {
              id: promo.id,
              code: promo.code,
              type: promo.type,
              value: promo.value,
            }
          : null,
      });
    }

    // 5) Paiement normal Stripe
    const amountInCents = Math.round(totalAmountEur * 100);

    const paymentIntent = await stripe.paymentIntents.create({
      amount: amountInCents,
      currency: "eur",
      metadata: {
        panier: JSON.stringify(panier),
        customer_email: customer?.email || "",
        customer_name:
          (customer?.prenom || "") + " " + (customer?.nom || ""),
        promo_code: promoCode || "",
        total_before_discount: String(totalBeforeDiscount),
        discount_amount: String(discountAmount),
        loyalty_used: loyaltyUsed ? "true" : "false",
      },
    });

    return res.json({
      clientSecret: paymentIntent.client_secret,
      isFree: false,
      totalBeforeDiscount,
      totalAfterDiscount: totalAmountEur,
      discountAmount,
      promo: promo
        ? { id: promo.id, code: promo.code, type: promo.type, value: promo.value }
        : null,
    });
  } catch (err) {
    console.error("Erreur create-payment-intent :", err);
    return res.status(500).json({ error: "Erreur serveur Stripe" });
  }
});

// ------------------------------------------------------
// 1bis) CRÉER UNE EMPREINTE DE CAUTION (250€)
// ------------------------------------------------------
app.post("/api/create-deposit-intent", async (req, res) => {
  try {
    if (!stripe) {
      return res.status(500).json({ error: "Stripe non configuré" });
    }

    const { reservationId, customer } = req.body;

    const depositAmountEur = DEPOSIT_AMOUNT_EUR;
    const amountInCents = Math.round(depositAmountEur * 100);

    console.log(
      "/api/create-deposit-intent - création empreinte",
      depositAmountEur,
      "€ pour réservation",
      reservationId
    );

    const fullName =
      (customer?.prenom || "") +
      (customer?.prenom ? " " : "") +
      (customer?.nom || "");

    const paymentIntent = await stripe.paymentIntents.create({
      amount: amountInCents,
      currency: "eur",
      capture_method: "manual", // ⚠️ empreinte bancaire
      automatic_payment_methods: {
        enabled: true,
      },
      metadata: {
        type: "singbox_deposit",
        reservation_id: reservationId || "",
        customer_email: customer?.email || "",
        customer_name: fullName,
      },
    });

    // Optionnel : on tente d'enregistrer l'ID de l'empreinte dans la réservation.
    if (supabase && reservationId) {
      try {
        await supabase
          .from("reservations")
          .update({
            deposit_payment_intent_id: paymentIntent.id,
            deposit_amount_cents: amountInCents,
            deposit_status: "authorized",
          })
          .eq("id", reservationId);
      } catch (e) {
        console.warn(
          "⚠️ Impossible de mettre à jour les infos de caution en BDD (colonnes manquantes ?):",
          e.message
        );
      }
    }

    return res.json({
      clientSecret: paymentIntent.client_secret,
      paymentIntentId: paymentIntent.id,
      depositAmountEur,
    });
  } catch (err) {
    console.error("Erreur create-deposit-intent :", err);
    return res
      .status(500)
      .json({ error: "Erreur serveur Stripe (caution)" });
  }
});

// ------------------------------------------------------
// 2) CONFIRMER LA RÉSERVATION APRÈS PAIEMENT RÉUSSI
// ------------------------------------------------------
app.post("/api/confirm-reservation", async (req, res) => {
  try {
    console.log("/api/confirm-reservation appelé");
    const {
      panier,
      customer,
      promoCode,
      paymentIntentId,
      loyaltyUsed,
      isFree,
    } = req.body || {};

    const isFreeReservationFlag = !!isFree || !!loyaltyUsed;

    if (!panier || !Array.isArray(panier) || panier.length === 0) {
      return res.status(400).json({ error: "Panier vide" });
    }

    // Si ce n'est PAS une séance gratuite, on vérifie le PaymentIntent Stripe
    if (!isFreeReservationFlag) {
      if (!paymentIntentId) {
        return res.status(400).json({ error: "paymentIntentId manquant" });
      }
      if (!stripe) {
        return res.status(500).json({ error: "Stripe non configuré" });
      }

      const pi = await stripe.paymentIntents.retrieve(paymentIntentId);
      console.log("Statut PaymentIntent :", pi.status);
      if (pi.status !== "succeeded") {
        return res
          .status(400)
          .json({ error: "Paiement non validé par Stripe" });
      }
    } else {
      console.log("✅ Réservation confirmée en mode gratuit (isFree / fidélité).");
    }

    if (!supabase) {
      console.warn(
        "⚠️ Supabase non configuré, réservation non enregistrée en base."
      );
      return res.json({ status: "ok (sans enregistrement Supabase)" });
    }

    // On essaie de récupérer l'userId depuis le token (s'il existe) pour la fidélité
    let userIdFromToken = null;
    try {
      const authHeader = req.headers.authorization;
      const token = authHeader?.startsWith("Bearer ")
        ? authHeader.split(" ")[1]
        : null;
      if (token) {
        const decoded = jwt.verify(token, process.env.JWT_SECRET);
        userIdFromToken = decoded.userId;
      }
    } catch (e) {
      console.warn(
        "⚠️ Token invalide sur /api/confirm-reservation :",
        e.message
      );
    }

    const fullName =
      (customer?.prenom || "") +
      (customer?.prenom ? " " : "") +
      (customer?.nom || "");

    // Recalculer le total pour les stats promo
    const totalBeforeDiscount = computeCartTotalEur(panier);
    let discountAmount = 0;
    let promo = null;

    if (promoCode) {
      const result = await validatePromoCode(promoCode, totalBeforeDiscount);
      if (result.ok) {
        discountAmount = result.discountAmount;
        promo = result.promo;
      } else {
        console.warn(
          "Code promo non appliqué lors de confirm-reservation :",
          result.reason
        );
      }
    }

    const rows = panier.map((slot) => {
      const times = buildTimesFromSlot(slot);

      const rawBox =
        slot.boxId ?? slot.box_id ?? slot.box ?? slot.boxName ?? 1;

      let numericBoxId = parseInt(String(rawBox).replace(/[^0-9]/g, ""), 10);
      if (!Number.isFinite(numericBoxId)) {
        numericBoxId = 1;
      }

      return {
        name: fullName || null,
        email: customer?.email || null,
        box_id: numericBoxId,
        start_time: times.start_time,
        end_time: times.end_time,
        date: times.date,
        datetime: times.datetime,
        status: "confirmed",
      };
    });

    console.log("Lignes à insérer dans reservations :", rows);

    for (const row of rows) {
      const { data: conflicts, error: conflictError } = await supabase
        .from("reservations")
        .select("id")
        .eq("box_id", row.box_id)
        .lt("start_time", row.end_time)
        .gt("end_time", row.start_time);

      if (conflictError) {
        console.error("Erreur vérification conflits :", conflictError);
        return res
          .status(500)
          .json({ error: "Erreur serveur (vérification conflit)" });
      }

      if (conflicts && conflicts.length > 0) {
        return res.status(400).json({
          error:
            "Ce créneau est déjà réservé pour la box " +
            row.box_id +
            ". Choisissez une autre heure ou une autre box.",
        });
      }
    }

    const { data, error } = await supabase
      .from("reservations")
      .insert(rows)
      .select();

    if (error) {
      console.error("Erreur Supabase insert reservations :", error);
      return res
        .status(500)
        .json({ error: "Erreur en enregistrant la réservation" });
    }

    console.log("✅ Réservations insérées :", data);

    try {
      await Promise.allSettled(data.map((row) => sendReservationEmail(row)));
    } catch (mailErr) {
      console.error("Erreur globale envoi mails :", mailErr);
    }

    // Fidélité : ajouter des points si l'utilisateur est identifié
    // et que la réservation n'est PAS gratuite (ni promo.free, ni fidélité, ni isFree)
    try {
      const isFreeReservationFinal =
        isFreeReservationFlag || (promo && promo.type === "free");

      if (!supabase) {
        console.log("Supabase non configuré, pas de points fidélité.");
      } else if (!userIdFromToken) {
        console.log("Aucun token fourni, pas d'ajout automatique de points.");
      } else if (isFreeReservationFinal) {
        console.log("🎁 Réservation gratuite → aucun point fidélité ajouté.");
      } else {
        const pointsToAdd = panier.length * 10;

        const { error: pointsError } = await supabase.rpc(
          "increment_points",
          {
            user_id: userIdFromToken,
            points_to_add: pointsToAdd,
          }
        );

        if (pointsError) {
          console.error("Erreur ajout points fidélité :", pointsError);
        } else {
          console.log(
            `⭐ ${pointsToAdd} points ajoutés à l'utilisateur ${userIdFromToken}`
          );
        }
      }
    } catch (pointsErr) {
      console.error(
        "Erreur lors de l'ajout automatique des points :",
        pointsErr
      );
    }

    // TRACE D’UTILISATION DU CODE PROMO
    try {
      if (promo && discountAmount > 0) {
        const totalAfterDiscount = Math.max(
          0,
          totalBeforeDiscount - discountAmount
        );

        await supabase.from("promo_usages").insert({
          promo_id: promo.id,
          code: promo.code,
          email: customer?.email || null,
          payment_intent_id: paymentIntentId || null,
          total_before: totalBeforeDiscount,
          total_after: totalAfterDiscount,
          discount_amount: discountAmount,
        });

        const currentUsed = Number(promo.used_count || 0);
        await supabase
          .from("promo_codes")
          .update({ used_count: currentUsed + 1 })
          .eq("id", promo.id);

        console.log(
          `📊 Promo ${promo.code} utilisée, remise=${discountAmount}€`
        );
      }
    } catch (promoErr) {
      console.error(
        "Erreur en enregistrant l'utilisation du code promo :",
        promoErr
      );
    }

    return res.json({
      status: "ok",
      reservations: data,
      promo: promo
        ? {
            code: promo.code,
            discountAmount,
            totalBefore: totalBeforeDiscount,
            totalAfter: Math.max(0, totalBeforeDiscount - discountAmount),
          }
        : null,
    });
  } catch (err) {
    console.error("Erreur confirm-reservation :", err);
    return res
      .status(500)
      .json({ error: "Erreur serveur lors de la réservation" });
  }
});

// ------------------------------------------------------
// 2bis) CAPTURER LA CAUTION (EN CAS DE CASSE)
// ------------------------------------------------------
app.post("/api/capture-deposit", async (req, res) => {
  try {
    if (!stripe) {
      return res.status(500).json({ error: "Stripe non configuré" });
    }

    const { paymentIntentId, amountToCaptureEur, reservationId } = req.body;

    if (!paymentIntentId) {
      return res
        .status(400)
        .json({ error: "paymentIntentId manquant pour la caution" });
    }

    let params = {};
    if (amountToCaptureEur != null) {
      const amountToCaptureCents = Math.round(
        Number(amountToCaptureEur) * 100
      );
      params.amount_to_capture = amountToCaptureCents;
    }

    console.log(
      "/api/capture-deposit - capture de la caution",
      amountToCaptureEur,
      "€ pour PaymentIntent",
      paymentIntentId
    );

    const paymentIntent = await stripe.paymentIntents.capture(
      paymentIntentId,
      params
    );

    if (supabase && reservationId) {
      try {
        await supabase
          .from("reservations")
          .update({
            deposit_status: "captured",
          })
          .eq("id", reservationId);
      } catch (e) {
        console.warn(
          "⚠️ Impossible de mettre à jour deposit_status en BDD :",
          e.message
        );
      }
    }

    return res.json({
      status: "captured",
      paymentIntent,
    });
  } catch (err) {
    console.error("Erreur capture-deposit :", err);
    return res
      .status(500)
      .json({ error: "Erreur serveur lors de la capture de la caution" });
  }
});

// ------------------------------------------------------
// 2ter) ANNULER / RELACHER LA CAUTION (PAS DE CASSE)
// ------------------------------------------------------
app.post("/api/cancel-deposit", async (req, res) => {
  try {
    if (!stripe) {
      return res.status(500).json({ error: "Stripe non configuré" });
    }

    const { paymentIntentId, reservationId } = req.body;

    if (!paymentIntentId) {
      return res
        .status(400)
        .json({ error: "paymentIntentId manquant pour la caution" });
    }

    console.log(
      "/api/cancel-deposit - annulation de la caution pour PaymentIntent",
      paymentIntentId
    );

    const canceled = await stripe.paymentIntents.cancel(paymentIntentId);

    if (supabase && reservationId) {
      try {
        await supabase
          .from("reservations")
          .update({
            deposit_status: "canceled",
          })
          .eq("id", reservationId);
      } catch (e) {
        console.warn(
          "⚠️ Impossible de mettre à jour deposit_status en BDD :",
          e.message
        );
      }
    }

    return res.json({
      status: "canceled",
      paymentIntent: canceled,
    });
  } catch (err) {
    console.error("Erreur cancel-deposit :", err);
    return res
      .status(500)
      .json({ error: "Erreur serveur lors de l'annulation de la caution" });
  }
});

// ------------------------------------------------------
// 3) /api/slots : planning
// ------------------------------------------------------
app.get("/api/slots", async (req, res) => {
  if (!supabase) {
    return res.status(500).json({ error: "Supabase non configuré" });
  }

  const date = req.query.date;
  if (!date) {
    return res
      .status(400)
      .json({ error: "Paramètre 'date' manquant (YYYY-MM-DD)" });
  }

  try {
    const dayStartLocal = new Date(`${date}T00:00:00`);
    const dayEndLocal = new Date(`${date}T23:59:59`);

    const dayStartIso = dayStartLocal.toISOString();
    const dayEndIso = dayEndLocal.toISOString();

    const { data, error } = await supabase
      .from("reservations")
      .select("id, box_id, start_time, end_time")
      .gte("start_time", dayStartIso)
      .lte("start_time", dayEndIso);

    if (error) {
      console.error("Erreur /api/slots Supabase :", error);
      return res.status(500).json({ error: "Erreur serveur Supabase" });
    }

    return res.json({ reservations: data || [] });
  } catch (e) {
    console.error("Erreur /api/slots :", e);
    return res.status(500).json({ error: "Erreur serveur" });
  }
});

// ------------------------------------------------------
// 4) /api/check : lecteur de QR
// ------------------------------------------------------
app.get("/api/check", async (req, res) => {
  if (!supabase) {
    return res
      .status(500)
      .json({ valid: false, error: "Supabase non configuré" });
  }

  try {
    const id = req.query.id;

    if (!id) {
      res.status(400);
      return res.json({ valid: false, error: "Missing id" });
    }

    const { data, error } = await supabase
      .from("reservations")
      .select("*")
      .eq("id", id)
      .single();

    if (error || !data) {
      res.status(404);
      return res.json({
        valid: false,
        reason: "Réservation introuvable.",
      });
    }

    const now = new Date();
    const start = new Date(data.start_time);
    const end = new Date(data.end_time);

    const marginBeforeMinutes = 5;
    const marginBeforeEndMinutes = 5;

    const startWithMargin = new Date(
      start.getTime() - marginBeforeMinutes * 60000
    );
    const lastEntryTime = new Date(
      end.getTime() - marginBeforeEndMinutes * 60000
    );

    let access = false;
    let reason = "OK";

    if (now < startWithMargin) {
      access = false;
      reason = "Trop tôt pour accéder à la box.";
    } else if (now > lastEntryTime) {
      access = false;
      reason = "Créneau terminé, accès refusé.";
    } else if (data.status !== "confirmed") {
      access = false;
      reason = `Statut invalide : ${data.status}`;
    } else {
      access = true;
      reason = "Créneau valide, accès autorisé.";
    }

    return res.json({
      valid: true,
      access,
      reason,
      reservation: data,
    });
  } catch (e) {
    console.error("Erreur /api/check :", e);
    res.status(500);
    return res.json({ valid: false, error: e.message });
  }
});

// ------------------------------------------------------
// Lancer le serveur
// ------------------------------------------------------
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log("✅ API Stripe/Supabase en écoute sur le port", PORT);
});
