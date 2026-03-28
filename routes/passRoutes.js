// backend/routes/passRoutes.js

import express from "express";

import { stripe } from "../config/stripe.js";
import { supabase } from "../config/supabase.js";
import { authMiddleware } from "../middlewares/auth.js";
import { hasReservationConflict } from "../services/reservationService.js";
import {
  analyzeCartForPass,
  buildPassPricingSummary,
  buildPassReservationRows,
  consumeUserPassPlaces,
  createPassTransaction,
  createPurchasedPass,
  getPassByPaymentIntentId,
  getPassCatalog,
  getUserPassById,
  listUserPasses,
  restoreUserPassPlaces,
} from "../services/passService.js";

import { sendReservationEmail } from "../services/emailService.js";

const router = express.Router();

function safeText(value, maxLen = 255) {
  return String(value ?? "").trim().slice(0, maxLen);
}

function normalizeEmail(email) {
  return safeText(email, 255).toLowerCase();
}

function buildFullName(customer = {}) {
  const prenom = safeText(customer.prenom, 120);
  const nom = safeText(customer.nom, 120);
  return `${prenom}${prenom && nom ? " " : ""}${nom}`.trim();
}

function readCartFromBody(body) {
  if (Array.isArray(body?.cart)) return body.cart;
  if (Array.isArray(body?.panier)) return body.panier;
  return [];
}

function ensureStripeConfigured(res) {
  if (!stripe) {
    res.status(500).json({ error: "Stripe non configuré" });
    return false;
  }
  return true;
}

function ensureSupabaseConfigured(res) {
  if (!supabase) {
    res.status(500).json({ error: "Supabase non configuré" });
    return false;
  }
  return true;
}

async function persistPassReservations(rows) {
  const { data, error } = await supabase
    .from("reservations")
    .insert(rows)
    .select("*");

  if (error) {
    console.error("persistPassReservations error:", error);
    throw error;
  }

  return data || [];
}

router.get("/api/passes/catalog", async (_req, res) => {
  return res.json({
    success: true,
    passes: getPassCatalog(),
  });
});

router.get("/api/passes/me", authMiddleware, async (req, res) => {
  try {
    if (!ensureSupabaseConfigured(res)) return;

    const passes = await listUserPasses(req.userId);

    return res.json({
      success: true,
      passes,
    });
  } catch (error) {
    console.error("Erreur /api/passes/me :", error);
    return res.status(500).json({ error: "Erreur serveur" });
  }
});

router.post("/api/passes/create-payment-intent", authMiddleware, async (req, res) => {
  try {
    if (!ensureStripeConfigured(res)) return;

    const passType = safeText(req.body?.passType, 80);
    const passDef = buildPassPricingSummary(passType);

    if (!passDef) {
      return res.status(400).json({ error: "Type de pass invalide" });
    }

    const paymentIntent = await stripe.paymentIntents.create({
      amount: passDef.amountInCents,
      currency: "eur",
      payment_method_types: ["card"],
      metadata: {
        kind: "pass_purchase",
        pass_type: passDef.type,
        user_id: String(req.userId),
        places: String(passDef.places),
        unit_price: String(passDef.price),
        validity_months: String(passDef.validityMonths || 3),
      },
    });

    return res.json({
      success: true,
      clientSecret: paymentIntent.client_secret,
      paymentIntentId: paymentIntent.id,
      pass: passDef,
    });
  } catch (error) {
    console.error("Erreur /api/passes/create-payment-intent :", error);
    return res.status(500).json({ error: "Erreur serveur" });
  }
});

router.post("/api/passes/confirm-purchase", authMiddleware, async (req, res) => {
  try {
    if (!ensureStripeConfigured(res)) return;
    if (!ensureSupabaseConfigured(res)) return;

    const paymentIntentId = safeText(req.body?.paymentIntentId, 200);
    const passType = safeText(req.body?.passType, 80);

    if (!paymentIntentId || !passType) {
      return res.status(400).json({
        error: "paymentIntentId et passType sont requis",
      });
    }

    const existingPass = await getPassByPaymentIntentId(paymentIntentId);
    if (existingPass) {
      return res.json({
        success: true,
        alreadyCreated: true,
        pass: existingPass,
      });
    }

    const passDef = buildPassPricingSummary(passType);
    if (!passDef) {
      return res.status(400).json({ error: "Type de pass invalide" });
    }

    const paymentIntent = await stripe.paymentIntents.retrieve(paymentIntentId);

    if (!paymentIntent) {
      return res.status(404).json({ error: "Paiement introuvable" });
    }

    if (paymentIntent.status !== "succeeded") {
      return res.status(409).json({
        error: "Le paiement n'est pas encore confirmé.",
        status: paymentIntent.status,
      });
    }

    if (String(paymentIntent.metadata?.kind || "") !== "pass_purchase") {
      return res.status(400).json({
        error: "Ce paiement ne correspond pas à un achat de pass.",
      });
    }

    if (String(paymentIntent.metadata?.user_id || "") !== String(req.userId)) {
      return res.status(403).json({
        error: "Ce paiement n'appartient pas à cet utilisateur.",
      });
    }

    if (String(paymentIntent.metadata?.pass_type || "") !== passDef.type) {
      return res.status(400).json({
        error: "Le type de pass ne correspond pas au paiement.",
      });
    }

    const createdPass = await createPurchasedPass({
      userId: req.userId,
      passType: passDef.type,
      paymentIntentId: paymentIntent.id,
      purchasePrice: passDef.price,
      metadata: {
        stripe_amount_received: paymentIntent.amount_received || paymentIntent.amount || 0,
      },
    });

    await createPassTransaction({
      userPassId: createdPass.id,
      userId: req.userId,
      transactionType: "purchase",
      deltaPlaces: passDef.places,
      notes: `Achat du pass ${passDef.label}`,
      metadata: {
        paymentIntentId: paymentIntent.id,
        passType: passDef.type,
      },
    });

    return res.json({
      success: true,
      pass: createdPass,
    });
  } catch (error) {
    console.error("Erreur /api/passes/confirm-purchase :", error);
    return res.status(500).json({ error: "Erreur serveur" });
  }
});

router.post("/api/passes/preview-usage", authMiddleware, async (req, res) => {
  try {
    if (!ensureSupabaseConfigured(res)) return;

    const cart = readCartFromBody(req.body || {});
    const userPassId = safeText(req.body?.userPassId, 120);
    const promoCode = safeText(req.body?.promoCode, 80);
    const singcoinsUsed = req.body?.singcoinsUsed === true;

    if (!cart.length) {
      return res.status(400).json({ error: "Panier vide" });
    }

    if (!userPassId) {
      return res.status(400).json({ error: "userPassId manquant" });
    }

    if (promoCode) {
      return res.status(400).json({
        error: "Un pass n'est pas cumulable avec un code promo.",
      });
    }

    if (singcoinsUsed) {
      return res.status(400).json({
        error: "Un pass n'est pas cumulable avec les Singcoins.",
      });
    }

    const userPass = await getUserPassById(userPassId, req.userId);
    if (!userPass) {
      return res.status(404).json({ error: "Pass introuvable" });
    }

    if (userPass.status !== "active" || userPass.is_expired) {
      return res.status(409).json({ error: "Ce pass n'est plus actif ou a expiré." });
    }

    const analysis = analyzeCartForPass(cart, userPass.pass_type);

    if (!analysis.ok) {
      return res.status(400).json({
        error: analysis.message,
        reason: analysis.reason,
      });
    }

    if (Number(userPass.remaining_places || 0) < Number(analysis.requiredPlaces || 0)) {
      return res.status(409).json({
        error: "Pas assez de places restantes sur ce pass.",
        requiredPlaces: analysis.requiredPlaces,
        remainingPlaces: userPass.remaining_places,
      });
    }

    return res.json({
      success: true,
      pass: userPass,
      requiredPlaces: analysis.requiredPlaces,
      remainingPlacesAfterUse:
        Number(userPass.remaining_places || 0) - Number(analysis.requiredPlaces || 0),
      theoreticalCartAmount: Number(analysis.pricing?.totalBeforeDiscount || 0),
      items: analysis.items,
    });
  } catch (error) {
    console.error("Erreur /api/passes/preview-usage :", error);
    return res.status(500).json({ error: "Erreur serveur" });
  }
});

router.post("/api/passes/confirm-reservation", authMiddleware, async (req, res) => {
  try {
    if (!ensureSupabaseConfigured(res)) return;

    const body = req.body || {};
    const cart = readCartFromBody(body);
    const customer = body.customer || {};
    const userPassId = safeText(body.userPassId, 120);
    const promoCode = safeText(body.promoCode, 80);
    const singcoinsUsed = body.singcoinsUsed === true;
    const paymentIntentId = safeText(body.paymentIntentId, 200);

    if (!cart.length) {
      return res.status(400).json({ error: "Panier vide" });
    }

    if (!userPassId) {
      return res.status(400).json({ error: "userPassId manquant" });
    }

    if (promoCode) {
      return res.status(400).json({
        error: "Un pass n'est pas cumulable avec un code promo.",
      });
    }

    if (singcoinsUsed) {
      return res.status(400).json({
        error: "Un pass n'est pas cumulable avec les Singcoins.",
      });
    }

    if (paymentIntentId) {
      return res.status(400).json({
        error: "Un pass ne doit pas être utilisé avec un paiement Stripe classique.",
      });
    }

    const customerEmail = normalizeEmail(customer.email);
    if (!customerEmail) {
      return res.status(400).json({ error: "Email client requis" });
    }

    if (!buildFullName(customer)) {
      return res.status(400).json({ error: "Nom du client requis" });
    }

    const userPass = await getUserPassById(userPassId, req.userId);
    if (!userPass) {
      return res.status(404).json({ error: "Pass introuvable" });
    }

    if (userPass.status !== "active" || userPass.is_expired) {
      return res.status(409).json({ error: "Ce pass n'est plus actif ou a expiré." });
    }

    const analysis = analyzeCartForPass(cart, userPass.pass_type);

    if (!analysis.ok) {
      return res.status(400).json({
        error: analysis.message,
        reason: analysis.reason,
      });
    }

    if (Number(userPass.remaining_places || 0) < Number(analysis.requiredPlaces || 0)) {
      return res.status(409).json({
        error: "Pas assez de places restantes sur ce pass.",
        requiredPlaces: analysis.requiredPlaces,
        remainingPlaces: userPass.remaining_places,
      });
    }

    for (const item of analysis.items || []) {
      const conflict = await hasReservationConflict({
        boxId: item.box_id,
        startTime: item.start_time,
        endTime: item.end_time,
        localDate: item.date,
      });

      if (conflict) {
        return res.status(409).json({
          error: "Un créneau sélectionné n'est plus disponible.",
          conflictItem: item,
        });
      }
    }

    const consumeResult = await consumeUserPassPlaces({
      userPassId: userPass.id,
      userId: req.userId,
      places: analysis.requiredPlaces,
    });

    if (!consumeResult?.success) {
      return res.status(409).json({
        error: "Impossible de consommer les places du pass.",
        reason: consumeResult?.pass_status || "unknown",
      });
    }

    let reservations = [];

    try {
      const rows = buildPassReservationRows({
        items: analysis.items,
        customer: {
          ...customer,
          email: customerEmail,
        },
        userId: req.userId,
        userPass,
      });

      reservations = await persistPassReservations(rows);

      for (const reservation of reservations) {
        await createPassTransaction({
          userPassId: userPass.id,
          userId: req.userId,
          reservationId: reservation.id,
          transactionType: "usage",
          deltaPlaces: -Number(reservation.persons || 0),
          notes: `Utilisation du pass pour la réservation ${reservation.id}`,
          metadata: {
            passType: userPass.pass_type,
          },
        });
      }

      // Envoi des emails de confirmation pour chaque réservation créée via pass
      for (const reservation of reservations) {
        try {
          await sendReservationEmail(reservation);
        } catch (mailError) {
          console.error("Erreur envoi email confirmation réservation pass :", mailError);
        }
      }
    } catch (reservationError) {
      console.error("Erreur création réservations via pass :", reservationError);

      try {
        await restoreUserPassPlaces({
          userPassId: userPass.id,
          userId: req.userId,
          places: analysis.requiredPlaces,
        });

        await createPassTransaction({
          userPassId: userPass.id,
          userId: req.userId,
          transactionType: "restore",
          deltaPlaces: analysis.requiredPlaces,
          notes: "Rollback automatique après échec de création de réservation",
          metadata: {},
        });
      } catch (rollbackError) {
        console.error("Erreur rollback pass :", rollbackError);
      }

      return res.status(500).json({
        error: reservationError?.message || "Erreur création réservation avec pass",
        details: String(reservationError?.stack || reservationError || ""),
      });
    }

    const updatedPass = await getUserPassById(userPass.id, req.userId);

    return res.json({
      success: true,
      reservations,
      pass: updatedPass,
      usedPlaces: analysis.requiredPlaces,
      theoreticalCartAmount: Number(analysis.pricing?.totalBeforeDiscount || 0),
    });
  } catch (error) {
    console.error("Erreur /api/passes/confirm-reservation :", error);
    return res.status(500).json({
      error: error?.message || "Erreur serveur",
      details: String(error?.stack || error || ""),
    });
  }
});

export default router;
