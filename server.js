// backend/server.js

import express from "express";
import cors from "cors";
import bodyParser from "body-parser";
import Stripe from "stripe";
import { createClient } from "@supabase/supabase-js";
import dotenv from "dotenv";
import { Resend } from "resend";
import QRCode from "qrcode";

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

// Prix par créneau (en €) -> à adapter à tes tarifs
const PRICE_PER_SLOT_EUR = 10;

// ------------------------------------------------------
// Helpers
// ------------------------------------------------------

// Construit start_time / end_time à partir du slot ou de date+hour
function buildTimesFromSlot(slot) {
  // Si le slot a déjà start_time / end_time, on les réutilise tels quels
  if (slot.start_time && slot.end_time) {
    const dateFromStart = slot.date || String(slot.start_time).slice(0, 10);
    return {
      start_time: slot.start_time,
      end_time: slot.end_time,
      date: dateFromStart,
      datetime: slot.start_time,
    };
  }

  const date = slot.date; // "YYYY-MM-DD"

  // hour peut être "15", 15, "15h - 16h", etc. -> on garde uniquement le nombre
  let hourNum = 0;
  if (typeof slot.hour === "number") {
    hourNum = slot.hour;
  } else if (slot.hour) {
    const match = String(slot.hour).match(/\d{1,2}/);
    hourNum = match ? parseInt(match[0], 10) : 0;
  } else {
    hourNum = 0;
  }

  // 🕒 offset de fuseau envoyé par le front (en minutes)
  // ex : Paris hiver = -60, été = -120
  const tzOffsetMinutes = Number(slot.tzOffsetMinutes ?? 0);

  // On décompose la date
  const [year, month, day] = date.split("-").map((x) => parseInt(x, 10));

  // On construit l'instant en UTC à partir de la date locale + offset
  // Local → UTC : on enlève l'offset (qui est négatif en Europe/Paris)
  const localUtcMillis = Date.UTC(year, month - 1, day, hourNum, 0, 0);
  const startUtc = new Date(localUtcMillis - tzOffsetMinutes * 60000);
  const endUtc = new Date(startUtc.getTime() + 60 * 60000);

  const startIso = startUtc.toISOString();
  const endIso = endUtc.toISOString();

  return {
    start_time: startIso,
    end_time: endIso,
    date: date,
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
    // 1) Génération du QR code (PNG en base64)
    const qrText = reservation.id; // le lecteur lit cet id
    const qrDataUrl = await QRCode.toDataURL(qrText);
    const base64Data = qrDataUrl.split(",")[1]; // on enlève le "data:image/png;base64,"

    // 2) Formatage des dates
    const start = reservation.start_time
      ? new Date(reservation.start_time)
      : null;
    const end = reservation.end_time ? new Date(reservation.end_time) : null;

    const fmt = (d) =>
      d
        ? d.toLocaleString("fr-FR", {
            day: "2-digit",
            month: "2-digit",
            year: "numeric",
            hour: "2-digit",
            minute: "2-digit",
          })
        : "N/A";

    const startStr = fmt(start);
    const endStr = fmt(end);

    const subject = `Votre réservation Singbox - Box ${reservation.box_id}`;

    // 3) HTML avec image inline via CID
    const htmlBody = `
      <p>Bonjour,</p>
      <p>Votre réservation <strong>Singbox</strong> a bien été enregistrée ✅</p>
      <p><strong>Détails de votre session :</strong></p>
      <ul>
        <li>Box : <strong>${reservation.box_id}</strong></li>
        <li>Début : <strong>${startStr}</strong></li>
        <li>Fin : <strong>${endStr}</strong></li>
      </ul>
      <p>Voici votre QR code (à présenter à l'entrée) :</p>
      <p><img src="cid:qrimage-singbox" alt="QR Code Singbox" /></p>
      <p>À très vite chez Singbox 🎤</p>
    `;

    console.log(
      "📧 Envoi de l'email (Resend) à",
      toEmail,
      "pour réservation",
      reservation.id
    );

    // 4) Envoi via Resend avec pièce jointe inline (CID)
    await resend.emails.send({
      from: "Singbox <onboarding@resend.dev>", // pour les tests ; plus tard ton propre domaine
      to: toEmail,
      subject,
      html: htmlBody,
      attachments: [
        {
          filename: "qr-reservation.png",
          content: base64Data, // base64 du PNG
          contentType: "image/png",
          content_id: "qrimage-singbox", // utilisé dans src="cid:qrimage-singbox"
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
// WEBHOOK STRIPE (⚠️ doit utiliser raw body)
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

// ⚠️ IMPORTANT : après le webhook, on remet JSON pour le reste
app.use(bodyParser.json());

console.log("🌍 CORS + JSON configurés");

// ------------------------------------------------------
// 0) Petite route de test
// ------------------------------------------------------
app.get("/", (req, res) => {
  res.send("API Singbox OK");
});

// ------------------------------------------------------
// 1) CRÉER UN PAYMENT INTENT STRIPE (mode test)
// ------------------------------------------------------
app.post("/api/create-payment-intent", async (req, res) => {
  try {
    if (!stripe) {
      return res.status(500).json({ error: "Stripe non configuré" });
    }

    console.log("/api/create-payment-intent appelé");
    const { panier, customer, promoCode } = req.body;

    if (!panier || !Array.isArray(panier) || panier.length === 0) {
      return res.status(400).json({ error: "Panier vide" });
    }

    // Montant simple : nombre d'items * prix unitaire
    let totalAmountEur = panier.length * PRICE_PER_SLOT_EUR;

    // Exemple de remise simple : SINGBOX10 => -10%
    if (promoCode === "SINGBOX10") {
      totalAmountEur = totalAmountEur * 0.9;
    }

    const amountInCents = Math.round(totalAmountEur * 100);
    console.log(
      "Montant total calculé :",
      totalAmountEur,
      "€ (" + amountInCents + " cents)"
    );

    const paymentIntent = await stripe.paymentIntents.create({
      amount: amountInCents,
      currency: "eur",
      metadata: {
        panier: JSON.stringify(panier),
        customer_email: customer?.email || "",
        customer_name:
          (customer?.prenom || "") + " " + (customer?.nom || ""),
      },
    });

    return res.json({ clientSecret: paymentIntent.client_secret });
  } catch (err) {
    console.error("Erreur create-payment-intent :", err);
    return res.status(500).json({ error: "Erreur serveur Stripe" });
  }
});

// ------------------------------------------------------
// 2) CONFIRMER LA RÉSERVATION APRÈS PAIEMENT RÉUSSI
// ------------------------------------------------------
app.post("/api/confirm-reservation", async (req, res) => {
  try {
    console.log("/api/confirm-reservation appelé");
    const { panier, customer, promoCode, paymentIntentId } = req.body;

    if (!paymentIntentId) {
      return res.status(400).json({ error: "paymentIntentId manquant" });
    }
    if (!panier || !Array.isArray(panier) || panier.length === 0) {
      return res.status(400).json({ error: "Panier vide" });
    }

    if (!stripe) {
      return res.status(500).json({ error: "Stripe non configuré" });
    }

    // 1) Vérifier le paiement chez Stripe
    const pi = await stripe.paymentIntents.retrieve(paymentIntentId);
    console.log("Statut PaymentIntent :", pi.status);
    if (pi.status !== "succeeded") {
      return res.status(400).json({ error: "Paiement non validé par Stripe" });
    }

    if (!supabase) {
      console.warn(
        "⚠️ Supabase non configuré, réservation non enregistrée en base."
      );
      return res.json({ status: "ok (sans enregistrement Supabase)" });
    }

    const fullName =
      (customer?.prenom || "") +
      (customer?.prenom ? " " : "") +
      (customer?.nom || "");

    // 2) Préparer les lignes de réservation pour Supabase
    const rows = panier.map((slot) => {
      const times = buildTimesFromSlot(slot);

      // Récupération "brute" de la box : "box1", 1, "2", "Box 3", etc.
      const rawBox =
        slot.boxId ?? slot.box_id ?? slot.box ?? slot.boxName ?? 1;

      // On enlève tout sauf les chiffres, puis on parse en int
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

    // 2bis) Vérifier les conflits pour chaque créneau
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

    // 3) Insertion en base
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

    // 4) Envoi d'email (en arrière-plan)
    try {
      await Promise.allSettled(data.map((row) => sendReservationEmail(row)));
    } catch (mailErr) {
      console.error("Erreur globale envoi mails :", mailErr);
    }

    return res.json({ status: "ok", reservations: data });
  } catch (err) {
    console.error("Erreur confirm-reservation :", err);
    return res
      .status(500)
      .json({ error: "Erreur serveur lors de la réservation" });
  }
});

// ------------------------------------------------------
// 3) /api/slots : utilisé par ton planning (reservation.html)
// ------------------------------------------------------
app.get("/api/slots", async (req, res) => {
  if (!supabase) {
    return res.status(500).json({ error: "Supabase non configuré" });
  }

  const date = req.query.date; // "YYYY-MM-DD"
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
// 4) /api/check : utilisé par ton lecteur de QR
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

    const marginBeforeMinutes = 5; // accès 5 min AVANT le début
    const marginBeforeEndMinutes = 5; // stop 5 min AVANT la fin

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
