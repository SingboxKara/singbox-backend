// backend/routes/paymentRoutes.js

import express from "express";

import { stripe } from "../config/stripe.js";
import { supabase } from "../config/supabase.js";
import { authMiddleware, optionalAuthMiddleware } from "../middlewares/auth.js";
import { authMiddleware as requireAuth } from "../middlewares/auth.js";
import { requireSupabaseAdmin } from "../middlewares/admin.js";
import {
  ensureStripeCustomer,
  saveDefaultCardToUsersTable,
} from "../services/stripeCustomerService.js";
import { getUserById } from "../services/userService.js";
import { computeCartPricing } from "../services/pricingService.js";
import {
  validatePromoCode,
  sanitizePromoForClient,
} from "../services/promoService.js";
import { updateReservationById } from "../services/reservationService.js";
import { getAvailableSingcoins } from "../services/singcoinService.js";
import { DEPOSIT_AMOUNT_EUR, SINGCOINS_REWARD_COST } from "../constants/booking.js";

const router = express.Router();

function normalizeEmail(email) {
  return String(email || "").trim().toLowerCase();
}

function buildPromoValidationContext({ customerEmail, panier }) {
  return {
    email: customerEmail || null,
    panier: Array.isArray(panier) ? panier : [],
  };
}

router.post("/api/create-setup-intent", requireAuth, async (req, res) => {
  try {
    if (!stripe) return res.status(500).json({ error: "Stripe non configuré" });
    if (!supabase) return res.status(500).json({ error: "Supabase non configuré" });

    const { customerId } = await ensureStripeCustomer(req.userId);

    const setupIntent = await stripe.setupIntents.create({
      customer: customerId,
      payment_method_types: ["card"],
      usage: "off_session",
      metadata: { supabase_user_id: String(req.userId) },
    });

    return res.json({ clientSecret: setupIntent.client_secret });
  } catch (e) {
    console.error("Erreur /api/create-setup-intent :", e);
    return res.status(500).json({ error: "Erreur serveur (setup intent)" });
  }
});

router.get("/api/payment-methods", authMiddleware, async (req, res) => {
  try {
    if (!stripe) return res.status(500).json({ error: "Stripe non configuré" });
    if (!supabase) return res.status(500).json({ error: "Supabase non configuré" });

    const { customerId } = await ensureStripeCustomer(req.userId);

    const paymentMethods = await stripe.paymentMethods.list({
      customer: customerId,
      type: "card",
    });

    const user = await getUserById(req.userId);

    return res.json({
      customerId,
      defaultPaymentMethodId: user.default_payment_method_id ?? null,
      methods: (paymentMethods.data || []).map((paymentMethod) => ({
        id: paymentMethod.id,
        brand: paymentMethod.card?.brand ?? null,
        last4: paymentMethod.card?.last4 ?? null,
        exp_month: paymentMethod.card?.exp_month ?? null,
        exp_year: paymentMethod.card?.exp_year ?? null,
      })),
    });
  } catch (e) {
    console.error("Erreur /api/payment-methods :", e);
    return res.status(500).json({ error: "Erreur serveur (list payment methods)" });
  }
});

router.post("/api/set-default-payment-method", authMiddleware, async (req, res) => {
  try {
    if (!stripe) return res.status(500).json({ error: "Stripe non configuré" });
    if (!supabase) return res.status(500).json({ error: "Supabase non configuré" });

    const { paymentMethodId } = req.body || {};
    if (!paymentMethodId) {
      return res.status(400).json({ error: "paymentMethodId manquant" });
    }

    const { customerId } = await ensureStripeCustomer(req.userId);

    try {
      await stripe.paymentMethods.attach(paymentMethodId, { customer: customerId });
    } catch (e) {
      const msg = String(e?.message || "");
      if (!msg.toLowerCase().includes("already") && !msg.toLowerCase().includes("attached")) {
        throw e;
      }
    }

    await stripe.customers.update(customerId, {
      invoice_settings: { default_payment_method: paymentMethodId },
    });

    const paymentMethod = await stripe.paymentMethods.retrieve(paymentMethodId);
    await saveDefaultCardToUsersTable(req.userId, paymentMethod);

    return res.json({ ok: true });
  } catch (e) {
    console.error("Erreur /api/set-default-payment-method :", e);
    return res.status(500).json({ error: "Erreur serveur (set default PM)" });
  }
});

router.post("/api/validate-promo", async (req, res) => {
  try {
    const { code, panier, singcoinsUsed, customer } = req.body || {};

    if (!code || !String(code).trim()) {
      return res.status(400).json({
        valid: false,
        error: "Code promo manquant.",
      });
    }

    if (singcoinsUsed) {
      return res.status(400).json({
        valid: false,
        error: "Un code promo ne peut pas être utilisé en même temps que les Singcoins.",
      });
    }

    let totalAmountEur = 0;

    if (Array.isArray(panier) && panier.length > 0) {
      const pricing = computeCartPricing(panier, { loyaltyUsed: false });
      totalAmountEur = pricing.totalCashDue;
    }

    const customerEmail = normalizeEmail(customer?.email);

    const result = await validatePromoCode(
      code,
      totalAmountEur,
      buildPromoValidationContext({
        customerEmail,
        panier,
      })
    );

    if (!result.ok) {
      return res.status(404).json({
        valid: false,
        error: "Ce code n’existe pas ou n’est plus valable.",
        reason: result.reason,
      });
    }

    return res.json({
      valid: true,
      promo: result.promoPublic || sanitizePromoForClient(result.promo),
      discountAmount: result.discountAmount,
      newTotal: result.newTotal,
    });
  } catch (e) {
    console.error("Erreur /api/validate-promo :", e);
    return res.status(500).json({
      valid: false,
      error: "Erreur serveur lors de la validation du code promo.",
    });
  }
});

router.post("/api/create-payment-intent", optionalAuthMiddleware, async (req, res) => {
  try {
    if (!stripe) {
      return res.status(500).json({ error: "Stripe non configuré" });
    }

    const {
      panier,
      customer,
      promoCode,
      singcoinsUsed,
      useSavedPaymentMethod,
      paymentMethodId,
      chestReward,
      rewardType,
      rewardValue,
    } = req.body || {};

    if (!panier || !Array.isArray(panier) || panier.length === 0) {
      return res.status(400).json({ error: "Panier vide" });
    }

    const customerEmail = normalizeEmail(customer?.email);
    if (!customerEmail) {
      return res.status(400).json({ error: "Email client requis" });
    }

    if (singcoinsUsed && !req.userId) {
      return res.status(401).json({
        error: "Connexion requise pour utiliser les Singcoins",
      });
    }

    if (singcoinsUsed && req.userId) {
      const currentSingcoins = await getAvailableSingcoins(req.userId);
      if (currentSingcoins < SINGCOINS_REWARD_COST) {
        return res.status(400).json({
          error: "Pas assez de Singcoins",
          currentSingcoins,
          requiredSingcoins: SINGCOINS_REWARD_COST,
        });
      }
    }

    const pricing = computeCartPricing(panier, { loyaltyUsed: !!singcoinsUsed });
    const totalBeforeDiscount = pricing.totalBeforeDiscount;
    const singcoinsDiscount = pricing.loyaltyDiscount;
    let totalAmountEur = pricing.totalCashDue;
    let promoDiscountAmount = 0;
    let promo = null;

    if (promoCode) {
      const result = await validatePromoCode(
        promoCode,
        totalAmountEur,
        buildPromoValidationContext({
          customerEmail,
          panier,
        })
      );

      if (result.ok) {
        totalAmountEur = result.newTotal;
        promoDiscountAmount = result.discountAmount;
        promo = result.promo;
      } else {
        console.warn("Code promo non appliqué :", result.reason);
      }
    }

    if (totalAmountEur <= 0) {
      return res.json({
        isFree: true,
        totalBeforeDiscount,
        singcoinsDiscount,
        promoDiscountAmount,
        totalAfterDiscount: 0,
        promo: promo
          ? { id: promo.id, code: promo.code, type: promo.type, value: promo.value }
          : null,
      });
    }

    const amountInCents = Math.round(totalAmountEur * 100);

    if (useSavedPaymentMethod) {
      if (!req.userId) {
        return res.status(401).json({ error: "Connexion requise pour payer avec carte enregistrée" });
      }
      if (!supabase) {
        return res.status(500).json({ error: "Supabase non configuré" });
      }

      const user = await getUserById(req.userId);
      const { customerId } = await ensureStripeCustomer(req.userId);

      const paymentMethodToUse = paymentMethodId || user.default_payment_method_id;
      if (!paymentMethodToUse) {
        return res.status(400).json({ error: "Aucune carte enregistrée disponible" });
      }

      try {
        await stripe.paymentMethods.attach(paymentMethodToUse, { customer: customerId });
      } catch (e) {
        const msg = String(e?.message || "");
        if (!msg.toLowerCase().includes("already") && !msg.toLowerCase().includes("attached")) {
          throw e;
        }
      }

      const fullName =
        (customer?.prenom || "") + (customer?.prenom ? " " : "") + (customer?.nom || "");

      try {
        const paymentIntent = await stripe.paymentIntents.create({
          amount: amountInCents,
          currency: "eur",
          customer: customerId,
          payment_method: paymentMethodToUse,
          payment_method_types: ["card"],
          metadata: {
            panier: JSON.stringify(pricing.normalizedItems),
            customer_email: customerEmail,
            customer_name: fullName,
            promo_code: promoCode || "",
            total_before_discount: String(totalBeforeDiscount),
            singcoins_discount_amount: String(singcoinsDiscount),
            promo_discount_amount: String(promoDiscountAmount),
            singcoins_used: singcoinsUsed ? "true" : "false",
            saved_card: "true",
            chest_reward: chestReward || "",
            reward_type: rewardType || "",
            reward_value: rewardValue != null ? String(rewardValue) : "",
          },
        });

        return res.json({
          clientSecret: paymentIntent.client_secret,
          paymentIntentId: paymentIntent.id,
          isFree: false,
          totalBeforeDiscount,
          singcoinsDiscount,
          promoDiscountAmount,
          totalAfterDiscount: totalAmountEur,
          promo: promo ? { id: promo.id, code: promo.code, type: promo.type, value: promo.value } : null,
        });
      } catch (e) {
        const stripeMsg =
          e?.raw?.message || e?.message || "Erreur Stripe inconnue (saved card)";
        console.error("❌ Stripe saved-card PI error:", stripeMsg, e?.raw || e);

        return res.status(500).json({
          error: "Stripe saved-card: " + stripeMsg,
        });
      }
    }

    const paymentIntent = await stripe.paymentIntents.create({
      amount: amountInCents,
      currency: "eur",
      payment_method_types: ["card"],
      metadata: {
        panier: JSON.stringify(pricing.normalizedItems),
        customer_email: customerEmail,
        customer_name: (customer?.prenom || "") + " " + (customer?.nom || ""),
        promo_code: promoCode || "",
        total_before_discount: String(totalBeforeDiscount),
        singcoins_discount_amount: String(singcoinsDiscount),
        promo_discount_amount: String(promoDiscountAmount),
        singcoins_used: singcoinsUsed ? "true" : "false",
        chest_reward: chestReward || "",
        reward_type: rewardType || "",
        reward_value: rewardValue != null ? String(rewardValue) : "",
      },
    });

    return res.json({
      clientSecret: paymentIntent.client_secret,
      paymentIntentId: paymentIntent.id,
      isFree: false,
      totalBeforeDiscount,
      singcoinsDiscount,
      promoDiscountAmount,
      totalAfterDiscount: totalAmountEur,
      promo: promo
        ? { id: promo.id, code: promo.code, type: promo.type, value: promo.value }
        : null,
    });
  } catch (err) {
    const msg = err?.raw?.message || err?.message || "Erreur serveur Stripe";
    console.error("Erreur create-payment-intent :", msg, err?.raw || err);
    return res.status(500).json({ error: msg });
  }
});

router.post("/api/create-deposit-intent", optionalAuthMiddleware, async (req, res) => {
  try {
    if (!stripe) return res.status(500).json({ error: "Stripe non configuré" });

    const { reservationId, customer, useSavedPaymentMethod, paymentMethodId } = req.body || {};
    const amountInCents = Math.round(DEPOSIT_AMOUNT_EUR * 100);

    const customerEmail = normalizeEmail(customer?.email);
    if (!customerEmail) {
      return res.status(400).json({ error: "Email client requis" });
    }

    const fullName =
      (customer?.prenom || "") + (customer?.prenom ? " " : "") + (customer?.nom || "");

    if (useSavedPaymentMethod) {
      if (!req.userId) {
        return res.status(401).json({ error: "Connexion requise pour la caution avec carte enregistrée" });
      }
      if (!supabase) {
        return res.status(500).json({ error: "Supabase non configuré" });
      }

      const user = await getUserById(req.userId);
      const { customerId } = await ensureStripeCustomer(req.userId);

      const paymentMethodToUse = paymentMethodId || user.default_payment_method_id;
      if (!paymentMethodToUse) {
        return res.status(400).json({ error: "Aucune carte enregistrée disponible pour la caution" });
      }

      try {
        await stripe.paymentMethods.attach(paymentMethodToUse, { customer: customerId });
      } catch (e) {
        const msg = String(e?.message || "");
        if (!msg.toLowerCase().includes("already") && !msg.toLowerCase().includes("attached")) {
          throw e;
        }
      }

      const paymentIntent = await stripe.paymentIntents.create({
        amount: amountInCents,
        currency: "eur",
        customer: customerId,
        payment_method: paymentMethodToUse,
        payment_method_types: ["card"],
        capture_method: "manual",
        metadata: {
          type: "singbox_deposit",
          reservation_id: reservationId || "",
          customer_email: customerEmail,
          customer_name: fullName,
          saved_card: "true",
        },
      });

      if (supabase && reservationId) {
        await updateReservationById(reservationId, {
          deposit_payment_intent_id: paymentIntent.id,
          deposit_amount_cents: amountInCents,
          deposit_status: "created",
          updated_at: new Date().toISOString(),
        });
      }

      return res.json({
        clientSecret: paymentIntent.client_secret,
        paymentIntentId: paymentIntent.id,
        depositAmountEur: DEPOSIT_AMOUNT_EUR,
      });
    }

    const paymentIntent = await stripe.paymentIntents.create({
      amount: amountInCents,
      currency: "eur",
      capture_method: "manual",
      payment_method_types: ["card"],
      metadata: {
        type: "singbox_deposit",
        reservation_id: reservationId || "",
        customer_email: customerEmail,
        customer_name: fullName,
      },
    });

    if (supabase && reservationId) {
      await updateReservationById(reservationId, {
        deposit_payment_intent_id: paymentIntent.id,
        deposit_amount_cents: amountInCents,
        deposit_status: "created",
        updated_at: new Date().toISOString(),
      });
    }

    return res.json({
      clientSecret: paymentIntent.client_secret,
      paymentIntentId: paymentIntent.id,
      depositAmountEur: DEPOSIT_AMOUNT_EUR,
    });
  } catch (err) {
    console.error("Erreur create-deposit-intent :", err);
    const msg = err?.raw?.message || err?.message || "Erreur serveur Stripe (caution)";
    return res.status(500).json({ error: msg });
  }
});

router.post("/api/capture-deposit", requireSupabaseAdmin, async (req, res) => {
  try {
    if (!stripe) {
      return res.status(500).json({ error: "Stripe non configuré" });
    }

    const { paymentIntentId, amountToCaptureEur, reservationId } = req.body || {};

    if (!paymentIntentId) {
      return res.status(400).json({ error: "paymentIntentId manquant pour la caution" });
    }

    const params = {};
    if (amountToCaptureEur != null) {
      params.amount_to_capture = Math.round(Number(amountToCaptureEur) * 100);
    }

    const paymentIntent = await stripe.paymentIntents.capture(paymentIntentId, params);

    if (supabase && reservationId) {
      await updateReservationById(reservationId, {
        deposit_status: "captured",
        updated_at: new Date().toISOString(),
      });
    }

    return res.json({ status: "captured", paymentIntent });
  } catch (err) {
    console.error("Erreur capture-deposit :", err);
    return res.status(500).json({ error: "Erreur serveur lors de la capture de la caution" });
  }
});

router.post("/api/cancel-deposit", requireSupabaseAdmin, async (req, res) => {
  try {
    if (!stripe) {
      return res.status(500).json({ error: "Stripe non configuré" });
    }

    const { paymentIntentId, reservationId } = req.body || {};

    if (!paymentIntentId) {
      return res.status(400).json({ error: "paymentIntentId manquant pour la caution" });
    }

    const canceled = await stripe.paymentIntents.cancel(paymentIntentId);

    if (supabase && reservationId) {
      await updateReservationById(reservationId, {
        deposit_status: "canceled",
        updated_at: new Date().toISOString(),
      });
    }

    return res.json({ status: "canceled", paymentIntent: canceled });
  } catch (err) {
    console.error("Erreur cancel-deposit :", err);
    return res.status(500).json({ error: "Erreur serveur lors de l'annulation de la caution" });
  }
});

export default router;