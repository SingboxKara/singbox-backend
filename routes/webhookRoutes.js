// backend/routes/webhookRoutes.js

import express from "express";
import bodyParser from "body-parser";

import { stripe } from "../config/stripe.js";
import { STRIPE_WEBHOOK_SECRET } from "../config/env.js";
import { supabase } from "../config/supabase.js";
import { applyReservationModification } from "../services/reservationService.js";

const router = express.Router();

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function safeText(value, maxLen = 255) {
  return String(value || "").trim().slice(0, maxLen);
}

function normalizeStatus(status) {
  return safeText(status, 80).toLowerCase();
}

function getStripeSignature(req) {
  const raw = req?.headers?.["stripe-signature"];

  if (typeof raw === "string" && raw.trim()) {
    return raw.trim();
  }

  if (Array.isArray(raw) && raw.length > 0) {
    const first = String(raw[0] || "").trim();
    return first || null;
  }

  return null;
}

async function markModificationRequestStatus(modificationRequestId, payload = {}) {
  if (!supabase || !modificationRequestId) return false;

  try {
    const { error } = await supabase
      .from("reservation_modification_requests")
      .update({
        ...payload,
        updated_at: new Date().toISOString(),
      })
      .eq("id", modificationRequestId);

    if (error) {
      console.error(
        "Erreur update reservation_modification_requests :",
        error
      );
      return false;
    }

    return true;
  } catch (err) {
    console.error(
      "Erreur catch update reservation_modification_requests :",
      err
    );
    return false;
  }
}

async function fetchModificationRequest(modificationRequestId) {
  if (!supabase || !modificationRequestId) return null;

  const { data, error } = await supabase
    .from("reservation_modification_requests")
    .select("*")
    .eq("id", modificationRequestId)
    .maybeSingle();

  if (error) {
    throw error;
  }

  return data || null;
}

async function handleModificationPaymentIntentSucceeded(intent) {
  if (!supabase) {
    console.error("Webhook modification: Supabase non configuré");
    return;
  }

  const modificationRequestId = safeText(
    intent?.metadata?.modification_request_id,
    120
  );

  if (!modificationRequestId) {
    console.warn(
      "Webhook modification ignoré : modification_request_id manquant"
    );
    return;
  }

  const modReq = await fetchModificationRequest(modificationRequestId);

  if (!modReq) {
    console.warn(
      "Webhook modification ignoré : requête de modification introuvable",
      { modificationRequestId }
    );
    return;
  }

  const currentStatus = normalizeStatus(modReq.status);

  if (currentStatus === "applied") {
    return;
  }

  if (currentStatus === "failed") {
    console.warn(
      "Webhook modification ignoré : requête déjà marquée failed",
      { modificationRequestId }
    );
    return;
  }

  if (currentStatus && currentStatus !== "pending") {
    console.warn(
      "Webhook modification ignoré : statut inattendu",
      {
        modificationRequestId,
        status: currentStatus,
      }
    );
    return;
  }

  if (
    modReq.stripe_payment_intent_id &&
    String(modReq.stripe_payment_intent_id) !== String(intent.id)
  ) {
    console.warn(
      "Webhook modification ignoré : payment_intent incohérent",
      {
        modificationRequestId,
        expected: modReq.stripe_payment_intent_id,
        received: intent.id,
      }
    );
    return;
  }

  try {
    await applyReservationModification({
      ...modReq,
      stripe_payment_intent_id: modReq.stripe_payment_intent_id || intent.id,
    });

    await markModificationRequestStatus(modificationRequestId, {
      status: "applied",
      stripe_payment_intent_id: modReq.stripe_payment_intent_id || intent.id,
    });
  } catch (applyErr) {
    console.error("Erreur application modification :", applyErr);

    await markModificationRequestStatus(modificationRequestId, {
      status: "failed",
      stripe_payment_intent_id: modReq.stripe_payment_intent_id || intent.id,
    });
  }
}

async function handlePaymentIntentSucceeded(event) {
  const intent = event?.data?.object;

  if (!intent || typeof intent !== "object") {
    console.warn("Webhook payment_intent.succeeded ignoré : objet invalide");
    return;
  }

  if (normalizeStatus(intent.metadata?.type) === "modification") {
    await handleModificationPaymentIntentSucceeded(intent);
    return;
  }
}

async function handlePaymentIntentPaymentFailed(event) {
  const intent = event?.data?.object;

  if (!intent || typeof intent !== "object") {
    return;
  }

  if (!supabase) {
    return;
  }

  if (normalizeStatus(intent.metadata?.type) !== "modification") {
    return;
  }

  const modificationRequestId = safeText(
    intent?.metadata?.modification_request_id,
    120
  );

  if (!modificationRequestId) {
    return;
  }

  const modReq = await fetchModificationRequest(modificationRequestId);
  if (!modReq) {
    return;
  }

  const currentStatus = normalizeStatus(modReq.status);
  if (currentStatus === "applied" || currentStatus === "failed") {
    return;
  }

  await markModificationRequestStatus(modificationRequestId, {
    status: "failed",
    stripe_payment_intent_id: modReq.stripe_payment_intent_id || intent.id,
  });
}

router.post(
  "/api/webhook",
  bodyParser.raw({ type: "application/json" }),
  async (req, res) => {
    if (!stripe) {
      console.error("❌ Webhook Stripe indisponible : stripe non configuré");
      return res.status(500).json({ error: "Stripe non configuré" });
    }

    if (!isNonEmptyString(STRIPE_WEBHOOK_SECRET)) {
      console.error(
        "❌ Webhook Stripe indisponible : STRIPE_WEBHOOK_SECRET manquant"
      );
      return res.status(500).json({ error: "Webhook non configuré" });
    }

    const sig = getStripeSignature(req);

    if (!isNonEmptyString(sig)) {
      console.error("❌ Webhook Stripe : signature manquante");
      return res.status(400).send();
    }

    let event;

    try {
      event = stripe.webhooks.constructEvent(
        req.body,
        sig,
        STRIPE_WEBHOOK_SECRET
      );
    } catch (err) {
      console.error("❌ Webhook error:", err.message);
      return res.status(400).send();
    }

    try {
      switch (event.type) {
        case "payment_intent.succeeded":
          await handlePaymentIntentSucceeded(event);
          break;

        case "payment_intent.payment_failed":
          await handlePaymentIntentPaymentFailed(event);
          break;

        default:
          break;
      }

      return res.json({ received: true });
    } catch (err) {
      console.error("Webhook processing error:", err);
      return res.sendStatus(500);
    }
  }
);

export default router;
