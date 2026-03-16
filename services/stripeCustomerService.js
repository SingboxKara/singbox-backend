// backend/services/stripeCustomerService.js

import { stripe } from "../config/stripe.js";
import { supabase } from "../config/supabase.js";
import { getUserById } from "./userService.js";
import { roundMoney } from "../utils/formatters.js";

export async function ensureStripeCustomer(userId) {
  if (!stripe) throw new Error("Stripe non configuré");
  if (!supabase) throw new Error("Supabase non configuré");

  const user = await getUserById(userId);

  if (user.stripe_customer_id) {
    return { customerId: user.stripe_customer_id, user };
  }

  const customer = await stripe.customers.create({
    email: user.email || undefined,
    metadata: { supabase_user_id: String(userId) },
  });

  const { error: upErr } = await supabase
    .from("users")
    .update({
      stripe_customer_id: customer.id,
      updated_at: new Date().toISOString(),
    })
    .eq("id", userId);

  if (upErr) throw upErr;

  const updated = await getUserById(userId);
  return { customerId: customer.id, user: updated };
}

export async function saveDefaultCardToUsersTable(userId, paymentMethod) {
  if (!supabase) throw new Error("Supabase non configuré");

  const card = paymentMethod?.card || {};

  const update = {
    default_payment_method_id: paymentMethod.id,
    card_brand: card.brand ?? null,
    card_last4: card.last4 ?? null,
    card_exp_month: card.exp_month ?? null,
    card_exp_year: card.exp_year ?? null,
    updated_at: new Date().toISOString(),
  };

  const { error } = await supabase.from("users").update(update).eq("id", userId);
  if (error) throw error;
}

export function getReservationPaymentIntentCandidates(reservation) {
  return [
    reservation?.latest_payment_intent_id,
    reservation?.payment_intent_id,
    reservation?.original_payment_intent_id,
  ].filter(Boolean);
}

export async function attemptAutomaticRefundAcrossPaymentIntents(reservation, refundAmountEur) {
  if (!stripe) throw new Error("Stripe non configuré");

  const candidates = getReservationPaymentIntentCandidates(reservation);
  if (!candidates.length || refundAmountEur <= 0) {
    return {
      success: false,
      skipped: true,
      reason: "Aucun payment_intent_id exploitable pour remboursement",
    };
  }

  let remaining = Math.round(refundAmountEur * 100);
  const refunds = [];

  for (const paymentIntentId of candidates) {
    if (remaining <= 0) break;

    try {
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

      const refundable = Math.max(0, totalCaptured - totalRefunded);
      if (refundable <= 0) continue;

      const refundNow = Math.min(remaining, refundable);

      if (refundNow > 0) {
        const refund = await stripe.refunds.create({
          payment_intent: paymentIntentId,
          amount: refundNow,
          reason: "requested_by_customer",
        });

        refunds.push(refund);
        remaining -= refundNow;
      }
    } catch (e) {
      console.warn("⚠️ Refund automatique impossible sur PI", paymentIntentId, e.message);
    }
  }

  if (remaining > 0) {
    return {
      success: false,
      skipped: false,
      partial: refunds.length > 0,
      refundedAmountEur: roundMoney((Math.round(refundAmountEur * 100) - remaining) / 100),
      reason: "Remboursement partiel ou impossible sur tous les paiements",
      refunds,
    };
  }

  return {
    success: true,
    refundedAmountEur: refundAmountEur,
    refunds,
  };
}

export async function attemptAutomaticSavedCardCharge({
  userId,
  customer,
  amountEur,
  metadata = {},
}) {
  if (!stripe) throw new Error("Stripe non configuré");
  if (!supabase) throw new Error("Supabase non configuré");

  const user = await getUserById(userId);
  const { customerId } = await ensureStripeCustomer(userId);

  const pmToUse = user.default_payment_method_id;
  if (!pmToUse) {
    return {
      success: false,
      requiresAdditionalPayment: true,
      reason: "Aucune carte enregistrée disponible",
    };
  }

  try {
    await stripe.paymentMethods.attach(pmToUse, { customer: customerId });
  } catch (e) {
    const msg = String(e?.message || "");
    if (!msg.toLowerCase().includes("already") && !msg.toLowerCase().includes("attached")) {
      throw e;
    }
  }

  const fullName =
    (customer?.prenom || "") + (customer?.prenom ? " " : "") + (customer?.nom || "");

  try {
    const pi = await stripe.paymentIntents.create({
      amount: Math.round(Number(amountEur) * 100),
      currency: "eur",
      customer: customerId,
      payment_method: pmToUse,
      payment_method_types: ["card"],
      confirm: true,
      off_session: true,
      metadata: {
        customer_email: customer?.email || user.email || "",
        customer_name: fullName,
        auto_modification_charge: "true",
        ...metadata,
      },
    });

    return {
      success: true,
      paymentIntent: pi,
    };
  } catch (e) {
    const code = e?.code || "";
    const paymentIntent = e?.raw?.payment_intent || null;

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
        reason: e?.message || "Authentification ou nouvelle carte requise",
      };
    }

    throw e;
  }
}