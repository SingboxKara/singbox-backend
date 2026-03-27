import express from "express";

import { stripe } from "../config/stripe.js";
import { supabase } from "../config/supabase.js";
import {
  authMiddleware,
  optionalAuthMiddleware,
} from "../middlewares/auth.js";
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
import {
  DEPOSIT_AMOUNT_EUR,
  SINGCOINS_REWARD_COST,
} from "../constants/booking.js";

const router = express.Router();

function normalizeEmail(email) {
  return String(email || "").trim().toLowerCase();
}

function safeText(value, maxLength = 500) {
  return String(value || "").trim().slice(0, maxLength);
}

function toSafeBoolean(value) {
  return value === true;
}

function toSafeNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function round2(value) {
  return Number(toSafeNumber(value, 0).toFixed(2));
}

function readCartFromBody(body) {
  if (Array.isArray(body?.cart)) return body.cart;
  if (Array.isArray(body?.panier)) return body.panier;
  return [];
}

function buildPromoValidationContext({ customerEmail, panier }) {
  return {
    email: customerEmail || null,
    panier: Array.isArray(panier) ? panier : [],
  };
}

function buildPromoPayload(promo) {
  return promo
    ? {
        id: promo.id ?? null,
        code: promo.code ?? null,
        type: promo.type ?? null,
        value: promo.value ?? null,
      }
    : null;
}

function buildCustomerFullName(customer) {
  const prenom = safeText(customer?.prenom, 120);
  const nom = safeText(customer?.nom, 120);
  return `${prenom}${prenom && nom ? " " : ""}${nom}`.trim();
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

function ensurePositiveAmountInCents(amountEur) {
  const cents = Math.round(toSafeNumber(amountEur, 0) * 100);
  return Math.max(0, cents);
}

async function tryAttachPaymentMethod(paymentMethodId, customerId) {
  try {
    await stripe.paymentMethods.attach(paymentMethodId, {
      customer: customerId,
    });
  } catch (e) {
    const msg = String(e?.message || "").toLowerCase();
    if (!msg.includes("already") && !msg.includes("attached")) {
      throw e;
    }
  }
}

async function retrieveOwnedPaymentMethodOrNull(paymentMethodId, customerId) {
  if (!paymentMethodId || !customerId) return null;

  const paymentMethod = await stripe.paymentMethods.retrieve(paymentMethodId);

  if (!paymentMethod || paymentMethod.customer !== customerId) {
    return null;
  }

  return paymentMethod;
}

function buildSharedPaymentIntentMetadata({
  pricing,
  customerEmail,
  customer,
  promoCode,
  singcoinsUsed,
  promoDiscountAmount,
  chestReward,
  rewardType,
  rewardValue,
}) {
  return {
    panier: JSON.stringify(pricing.normalizedItems || []),
    customer_email: customerEmail,
    customer_name: buildCustomerFullName(customer),
    promo_code: promoCode || "",
    total_before_discount: String(toSafeNumber(pricing.totalBeforeDiscount, 0)),
    singcoins_discount_amount: String(
      toSafeNumber(pricing.singcoinsDiscount, 0)
    ),
    promo_discount_amount: String(toSafeNumber(promoDiscountAmount, 0)),
    singcoins_used: singcoinsUsed ? "true" : "false",
    chest_reward: chestReward || "",
    reward_type: rewardType || "",
    reward_value: rewardValue != null ? String(rewardValue) : "",
  };
}

/* =========================================================
   SETUP INTENT
========================================================= */

router.post("/api/create-setup-intent", authMiddleware, async (req, res) => {
  try {
    if (!ensureStripeConfigured(res)) return;
    if (!ensureSupabaseConfigured(res)) return;

    const { customerId } = await ensureStripeCustomer(req.userId);

    const setupIntent = await stripe.setupIntents.create({
      customer: customerId,
      payment_method_types: ["card"],
      usage: "off_session",
      metadata: { supabase_user_id: String(req.userId) },
    });

    return res.json({
      clientSecret: setupIntent.client_secret,
      setupIntentId: setupIntent.id,
    });
  } catch (e) {
    console.error("Erreur /api/create-setup-intent :", e);
    return res.status(500).json({ error: "Erreur serveur (setup intent)" });
  }
});

/* =========================================================
   LIST PAYMENT METHODS
========================================================= */

router.get("/api/payment-methods", authMiddleware, async (req, res) => {
  try {
    if (!ensureStripeConfigured(res)) return;
    if (!ensureSupabaseConfigured(res)) return;

    const { customerId } = await ensureStripeCustomer(req.userId);

    const paymentMethods = await stripe.paymentMethods.list({
      customer: customerId,
      type: "card",
    });

    const user = await getUserById(req.userId);

    return res.json({
      customerId,
      defaultPaymentMethodId: user?.default_payment_method_id ?? null,
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
    return res
      .status(500)
      .json({ error: "Erreur serveur (list payment methods)" });
  }
});

/* =========================================================
   SET DEFAULT PAYMENT METHOD
========================================================= */

router.post("/api/set-default-payment-method", authMiddleware, async (req, res) => {
  try {
    if (!ensureStripeConfigured(res)) return;
    if (!ensureSupabaseConfigured(res)) return;

    const paymentMethodId = safeText(req.body?.paymentMethodId, 200);

    if (!paymentMethodId) {
      return res.status(400).json({ error: "paymentMethodId manquant" });
    }

    const { customerId } = await ensureStripeCustomer(req.userId);

    await tryAttachPaymentMethod(paymentMethodId, customerId);

    const paymentMethod = await retrieveOwnedPaymentMethodOrNull(
      paymentMethodId,
      customerId
    );

    if (!paymentMethod) {
      return res.status(403).json({
        error: "Cette carte n'appartient pas à ce client",
      });
    }

    await stripe.customers.update(customerId, {
      invoice_settings: { default_payment_method: paymentMethodId },
    });

    await saveDefaultCardToUsersTable(req.userId, paymentMethod);

    return res.json({ ok: true });
  } catch (e) {
    console.error("Erreur /api/set-default-payment-method :", e);
    return res.status(500).json({ error: "Erreur serveur (set default PM)" });
  }
});

/* =========================================================
   VALIDATE PROMO
========================================================= */

router.post("/api/validate-promo", async (req, res) => {
  try {
    const code = safeText(req.body?.code, 120);
    const panier = readCartFromBody(req.body || {});
    const singcoinsUsed = toSafeBoolean(req.body?.singcoinsUsed);
    const customer = req.body?.customer || null;

    if (!code) {
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

    if (panier.length > 0) {
      const pricing = computeCartPricing(panier, { singcoinsUsed: false });
      totalAmountEur = toSafeNumber(pricing.totalCashDue, 0);
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
      discountAmount: round2(result.discountAmount),
      newTotal: round2(result.newTotal),
    });
  } catch (e) {
    console.error("Erreur /api/validate-promo :", e);
    return res.status(500).json({
      valid: false,
      error: "Erreur serveur lors de la validation du code promo.",
    });
  }
});

/* =========================================================
   CREATE PAYMENT INTENT
========================================================= */

router.post("/api/create-payment-intent", optionalAuthMiddleware, async (req, res) => {
  try {
    if (!ensureStripeConfigured(res)) return;

    const panier = readCartFromBody(req.body || {});
    const customer = req.body?.customer || {};
    const promoCode = safeText(req.body?.promoCode, 120) || null;
    const singcoinsUsed = toSafeBoolean(req.body?.singcoinsUsed);
    const useSavedPaymentMethod = toSafeBoolean(req.body?.useSavedPaymentMethod);
    const paymentMethodId = safeText(req.body?.paymentMethodId, 200) || null;
    const chestReward = safeText(req.body?.chestReward, 120) || "";
    const rewardType = safeText(req.body?.rewardType, 120) || "";
    const rewardValue = req.body?.rewardValue;

    if (!panier.length) {
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

    const pricing = computeCartPricing(panier, {
      singcoinsUsed: !!singcoinsUsed,
    });

    const totalBeforeDiscount = round2(pricing.totalBeforeDiscount || 0);
    const singcoinsDiscount = round2(pricing.singcoinsDiscount || 0);
    let totalAmountEur = round2(pricing.totalCashDue || 0);
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
        totalAmountEur = round2(result.newTotal);
        promoDiscountAmount = round2(result.discountAmount);
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
        promo: buildPromoPayload(promo),
      });
    }

    const amountInCents = ensurePositiveAmountInCents(totalAmountEur);

    if (amountInCents <= 0) {
      return res.status(400).json({
        error: "Montant de paiement invalide",
      });
    }

    if (useSavedPaymentMethod) {
      if (!req.userId) {
        return res.status(401).json({
          error: "Connexion requise pour payer avec carte enregistrée",
        });
      }

      if (!ensureSupabaseConfigured(res)) return;

      const user = await getUserById(req.userId);
      const { customerId } = await ensureStripeCustomer(req.userId);

      const paymentMethodToUse =
        paymentMethodId || user?.default_payment_method_id || null;

      if (!paymentMethodToUse) {
        return res.status(400).json({
          error: "Aucune carte enregistrée disponible",
        });
      }

      await tryAttachPaymentMethod(paymentMethodToUse, customerId);

      const paymentMethod = await retrieveOwnedPaymentMethodOrNull(
        paymentMethodToUse,
        customerId
      );

      if (!paymentMethod) {
        return res.status(403).json({
          error: "Cette carte n'appartient pas à ce client",
        });
      }

      try {
        const paymentIntent = await stripe.paymentIntents.create({
          amount: amountInCents,
          currency: "eur",
          customer: customerId,
          payment_method: paymentMethodToUse,
          payment_method_types: ["card"],
          metadata: {
            ...buildSharedPaymentIntentMetadata({
              pricing,
              customerEmail,
              customer,
              promoCode,
              singcoinsUsed,
              promoDiscountAmount,
              chestReward,
              rewardType,
              rewardValue,
            }),
            saved_card: "true",
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
          promo: buildPromoPayload(promo),
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
      metadata: buildSharedPaymentIntentMetadata({
        pricing,
        customerEmail,
        customer,
        promoCode,
        singcoinsUsed,
        promoDiscountAmount,
        chestReward,
        rewardType,
        rewardValue,
      }),
    });

    return res.json({
      clientSecret: paymentIntent.client_secret,
      paymentIntentId: paymentIntent.id,
      isFree: false,
      totalBeforeDiscount,
      singcoinsDiscount,
      promoDiscountAmount,
      totalAfterDiscount: totalAmountEur,
      promo: buildPromoPayload(promo),
    });
  } catch (err) {
    const msg = err?.raw?.message || err?.message || "Erreur serveur Stripe";
    console.error("Erreur create-payment-intent :", msg, err?.raw || err);
    return res.status(500).json({ error: msg });
  }
});

/* =========================================================
   CREATE DEPOSIT INTENT
========================================================= */

router.post("/api/create-deposit-intent", optionalAuthMiddleware, async (req, res) => {
  try {
    if (!ensureStripeConfigured(res)) return;

    const reservationId = safeText(req.body?.reservationId, 120) || null;
    const customer = req.body?.customer || {};
    const useSavedPaymentMethod = toSafeBoolean(req.body?.useSavedPaymentMethod);
    const paymentMethodId = safeText(req.body?.paymentMethodId, 200) || null;
    const amountInCents = ensurePositiveAmountInCents(DEPOSIT_AMOUNT_EUR);

    const customerEmail = normalizeEmail(customer?.email);
    if (!customerEmail) {
      return res.status(400).json({ error: "Email client requis" });
    }

    const fullName = buildCustomerFullName(customer);

    if (useSavedPaymentMethod) {
      if (!req.userId) {
        return res.status(401).json({
          error: "Connexion requise pour la caution avec carte enregistrée",
        });
      }

      if (!ensureSupabaseConfigured(res)) return;

      const user = await getUserById(req.userId);
      const { customerId } = await ensureStripeCustomer(req.userId);

      const paymentMethodToUse =
        paymentMethodId || user?.default_payment_method_id || null;

      if (!paymentMethodToUse) {
        return res.status(400).json({
          error: "Aucune carte enregistrée disponible pour la caution",
        });
      }

      await tryAttachPaymentMethod(paymentMethodToUse, customerId);

      const paymentMethod = await retrieveOwnedPaymentMethodOrNull(
        paymentMethodToUse,
        customerId
      );

      if (!paymentMethod) {
        return res.status(403).json({
          error: "Cette carte n'appartient pas à ce client",
        });
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
    const msg =
      err?.raw?.message || err?.message || "Erreur serveur Stripe (caution)";
    return res.status(500).json({ error: msg });
  }
});

/* =========================================================
   CAPTURE DEPOSIT
========================================================= */

router.post("/api/capture-deposit", requireSupabaseAdmin, async (req, res) => {
  try {
    if (!ensureStripeConfigured(res)) return;

    const paymentIntentId = safeText(req.body?.paymentIntentId, 200);
    const reservationId = safeText(req.body?.reservationId, 120) || null;
    const amountToCaptureEur = req.body?.amountToCaptureEur;

    if (!paymentIntentId) {
      return res.status(400).json({
        error: "paymentIntentId manquant pour la caution",
      });
    }

    const params = {};

    if (amountToCaptureEur != null) {
      const amount = Number(amountToCaptureEur);

      if (!Number.isFinite(amount) || amount < 0) {
        return res.status(400).json({
          error: "amountToCaptureEur invalide",
        });
      }

      params.amount_to_capture = Math.round(amount * 100);
    }

    const paymentIntent = await stripe.paymentIntents.capture(
      paymentIntentId,
      params
    );

    if (supabase && reservationId) {
      await updateReservationById(reservationId, {
        deposit_status: "captured",
        updated_at: new Date().toISOString(),
      });
    }

    return res.json({ status: "captured", paymentIntent });
  } catch (err) {
    console.error("Erreur capture-deposit :", err);
    return res.status(500).json({
      error: "Erreur serveur lors de la capture de la caution",
    });
  }
});

/* =========================================================
   CANCEL DEPOSIT
========================================================= */

router.post("/api/cancel-deposit", requireSupabaseAdmin, async (req, res) => {
  try {
    if (!ensureStripeConfigured(res)) return;

    const paymentIntentId = safeText(req.body?.paymentIntentId, 200);
    const reservationId = safeText(req.body?.reservationId, 120) || null;

    if (!paymentIntentId) {
      return res.status(400).json({
        error: "paymentIntentId manquant pour la caution",
      });
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
    return res.status(500).json({
      error: "Erreur serveur lors de l'annulation de la caution",
    });
  }
});

export default router;
