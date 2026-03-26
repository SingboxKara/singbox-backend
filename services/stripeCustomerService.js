// backend/services/stripeCustomerService.js

import { stripe } from "../config/stripe.js";
import { supabase } from "../config/supabase.js";
import { getUserById } from "./userService.js";
import { roundMoney } from "../utils/formatters.js";

function ensureStripe() {
  if (!stripe) {
    throw new Error("Stripe non configuré");
  }
}

function ensureSupabase() {
  if (!supabase) {
    throw new Error("Supabase non configuré");
  }
}

function safeText(value, maxLen = 255) {
  return String(value || "").trim().slice(0, maxLen);
}

function normalizeEmail(email) {
  return String(email || "").trim().toLowerCase();
}

function toSafeAmountEur(amount) {
  const n = Number(amount);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, roundMoney(n));
}

function toAmountCents(amountEur) {
  return Math.max(0, Math.round(toSafeAmountEur(amountEur) * 100));
}

function buildCustomerFullName(customer = {}) {
  const prenom = safeText(customer?.prenom, 120);
  const nom = safeText(customer?.nom, 120);
  return `${prenom}${prenom && nom ? " " : ""}${nom}`.trim();
}

async function getExistingStripeCustomer(customerId) {
  if (!customerId) return null;

  try {
    const customer = await stripe.customers.retrieve(customerId);
    if (customer?.deleted) {
      return null;
    }
    return customer || null;
  } catch (error) {
    console.warn("⚠️ Impossible de relire le customer Stripe existant :", customerId, error?.message || error);
    return null;
  }
}

async function persistStripeCustomerId(userId, customerId) {
  const { error } = await supabase
    .from("users")
    .update({
      stripe_customer_id: customerId,
      updated_at: new Date().toISOString(),
    })
    .eq("id", userId);

  if (error) {
    throw error;
  }
}

async function attachPaymentMethodIfNeeded(paymentMethodId, customerId) {
  if (!paymentMethodId || !customerId) return;

  try {
    await stripe.paymentMethods.attach(paymentMethodId, {
      customer: customerId,
    });
  } catch (error) {
    const msg = String(error?.message || "").toLowerCase();
    if (!msg.includes("already") && !msg.includes("attached")) {
      throw error;
    }
  }
}

export async function ensureStripeCustomer(userId) {
  ensureStripe();
  ensureSupabase();

  const safeUserId = safeText(userId, 120);
  if (!safeUserId) {
    throw new Error("userId manquant");
  }

  const user = await getUserById(safeUserId);
  if (!user?.id) {
    throw new Error("Utilisateur introuvable");
  }

  const existingCustomerId = safeText(user.stripe_customer_id, 120);

  if (existingCustomerId) {
    const existingCustomer = await getExistingStripeCustomer(existingCustomerId);

    if (existingCustomer) {
      return { customerId: existingCustomerId, user };
    }

    console.warn("⚠️ stripe_customer_id présent en base mais introuvable côté Stripe, recréation :", existingCustomerId);
  }

  const customer = await stripe.customers.create({
    email: normalizeEmail(user.email) || undefined,
    metadata: { supabase_user_id: String(safeUserId) },
  });

  await persistStripeCustomerId(safeUserId, customer.id);

  const updated = await getUserById(safeUserId);
  return { customerId: customer.id, user: updated };
}

export async function saveDefaultCardToUsersTable(userId, paymentMethod) {
  ensureSupabase();

  const safeUserId = safeText(userId, 120);
  if (!safeUserId) {
    throw new Error("userId manquant");
  }

  if (!paymentMethod?.id) {
    throw new Error("paymentMethod invalide");
  }

  const card = paymentMethod?.card || {};

  const update = {
    default_payment_method_id: paymentMethod.id,
    card_brand: card.brand ?? null,
    card_last4: card.last4 ?? null,
    card_exp_month: card.exp_month ?? null,
    card_exp_year: card.exp_year ?? null,
    updated_at: new Date().toISOString(),
  };

  const { error } = await supabase
    .from("users")
    .update(update)
    .eq("id", safeUserId);

  if (error) {
    throw error;
  }
}

export function getReservationPaymentIntentCandidates(reservation) {
  const rawCandidates = [
    reservation?.latest_payment_intent_id,
    reservation?.payment_intent_id,
    reservation?.original_payment_intent_id,
  ]
    .map((value) => safeText(value, 200))
    .filter(Boolean);

  return [...new Set(rawCandidates)];
}

async function getRefundableAmountForPaymentIntent(paymentIntentId) {
  const charges = await stripe.charges.list({
    payment_intent: paymentIntentId,
    limit: 100,
  });

  const chargeList = charges?.data || [];

  const totalCaptured = chargeList.reduce((sum, charge) => {
    return sum + Number(charge.amount_captured || charge.amount || 0);
  }, 0);

  const totalRefunded = chargeList.reduce((sum, charge) => {
    return sum + Number(charge.amount_refunded || 0);
  }, 0);

  return Math.max(0, totalCaptured - totalRefunded);
}

export async function attemptAutomaticRefundAcrossPaymentIntents(
  reservation,
  refundAmountEur
) {
  ensureStripe();

  const candidates = getReservationPaymentIntentCandidates(reservation);
  const requestedRefundCents = toAmountCents(refundAmountEur);

  if (!candidates.length || requestedRefundCents <= 0) {
    return {
      success: false,
      skipped: true,
      reason: "Aucun payment_intent_id exploitable pour remboursement",
    };
  }

  let remaining = requestedRefundCents;
  const refunds = [];

  for (const paymentIntentId of candidates) {
    if (remaining <= 0) break;

    try {
      const refundable = await getRefundableAmountForPaymentIntent(paymentIntentId);
      if (refundable <= 0) continue;

      const refundNow = Math.min(remaining, refundable);
      if (refundNow <= 0) continue;

      const refund = await stripe.refunds.create({
        payment_intent: paymentIntentId,
        amount: refundNow,
        reason: "requested_by_customer",
      });

      refunds.push(refund);
      remaining -= refundNow;
    } catch (error) {
      console.warn(
        "⚠️ Refund automatique impossible sur PI",
        paymentIntentId,
        error?.message || error
      );
    }
  }

  const refundedCents = requestedRefundCents - remaining;
  const refundedAmountEur = roundMoney(refundedCents / 100);

  if (remaining > 0) {
    return {
      success: false,
      skipped: false,
      partial: refunds.length > 0,
      refundedAmountEur,
      reason: "Remboursement partiel ou impossible sur tous les paiements",
      refunds,
    };
  }

  return {
    success: true,
    refundedAmountEur,
    refunds,
  };
}

export async function attemptAutomaticSavedCardCharge({
  userId,
  customer,
  amountEur,
  metadata = {},
}) {
  ensureStripe();
  ensureSupabase();

  const safeUserId = safeText(userId, 120);
  if (!safeUserId) {
    throw new Error("userId manquant");
  }

  const amountCents = toAmountCents(amountEur);
  if (amountCents <= 0) {
    return {
      success: false,
      requiresAdditionalPayment: false,
      reason: "Montant invalide",
    };
  }

  const user = await getUserById(safeUserId);
  if (!user?.id) {
    throw new Error("Utilisateur introuvable");
  }

  const { customerId } = await ensureStripeCustomer(safeUserId);

  const pmToUse = safeText(user.default_payment_method_id, 200);
  if (!pmToUse) {
    return {
      success: false,
      requiresAdditionalPayment: true,
      reason: "Aucune carte enregistrée disponible",
    };
  }

  await attachPaymentMethodIfNeeded(pmToUse, customerId);

  const fullName = buildCustomerFullName(customer);
  const customerEmail =
    normalizeEmail(customer?.email) || normalizeEmail(user.email) || "";

  try {
    const pi = await stripe.paymentIntents.create({
      amount: amountCents,
      currency: "eur",
      customer: customerId,
      payment_method: pmToUse,
      payment_method_types: ["card"],
      confirm: true,
      off_session: true,
      metadata: {
        customer_email: customerEmail,
        customer_name: fullName,
        auto_modification_charge: "true",
        ...metadata,
      },
    });

    return {
      success: true,
      paymentIntent: pi,
    };
  } catch (error) {
    const code = error?.code || "";
    const paymentIntent = error?.raw?.payment_intent || error?.payment_intent || null;
    const message =
      error?.raw?.message || error?.message || "Authentification ou nouvelle carte requise";

    if (
      code === "authentication_required" ||
      code === "card_declined" ||
      paymentIntent?.client_secret
    ) {
      return {
        success: false,
        requiresAdditionalPayment: true,
        clientSecret: paymentIntent?.client_secret || null,
        paymentIntentId: paymentIntent?.id || null,
        reason: message,
      };
    }

    throw error;
  }
}
