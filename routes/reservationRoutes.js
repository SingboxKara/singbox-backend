import express from "express";
import jwt from "jsonwebtoken";

import { supabase } from "../config/supabase.js";
import { stripe } from "../config/stripe.js";
import { JWT_SECRET } from "../config/env.js";
import { authMiddleware } from "../middlewares/auth.js";

import {
  buildTimesFromSlot,
  computeCartPricing,
  computeSessionCashAmount,
  computeModificationDelta,
  buildSlotIsoRange,
  STANDARD_SLOT_STARTS,
} from "../services/pricingService.js";

import {
  hasReservationConflict,
  isReservationStatusModifiable,
  isWithinModificationWindow,
  isWithinRefundWindow,
  updateReservationById,
  getReservationByGuestToken,
  generateGuestManageToken,
  normalizeReservationStatus,
  isPaymentIntentAlreadyUsed,
} from "../services/reservationService.js";

import {
  updateUserProfileInUsersTable,
  getReservationOwnedByUser,
} from "../services/userService.js";

import {
  isReservationPaidWithLoyalty,
  getReservationLoyaltyPointsUsed,
  getReservationPersons,
  consumeLoyaltyPointsForUser,
  refundPointsToUser,
} from "../services/singcoinService.js";

import {
  attemptAutomaticSavedCardCharge,
  attemptAutomaticRefundAcrossPaymentIntents,
} from "../services/stripeCustomerService.js";

import {
  creditSingcoins,
  getUserGamificationSnapshot,
} from "../services/gamificationService.js";

import { clampPersons, getNumericBoxId } from "../utils/validators.js";
import { parseDateOrNull, formatDateToYYYYMMDD } from "../utils/dates.js";
import { roundMoney } from "../utils/formatters.js";
import {
  MODIFICATION_DEADLINE_HOURS,
  REFUND_DEADLINE_HOURS,
  SLOT_DURATION_MINUTES,
  LOYALTY_POINTS_COST,
} from "../constants/booking.js";

import {
  sendReservationEmail,
  sendReservationModificationEmail,
} from "../services/emailService.js";
import { validatePromoCode } from "../services/promoService.js";

const router = express.Router();

function normalizeEmail(email) {
  return String(email || "").trim().toLowerCase();
}

function buildGuestReservationResponse(reservation) {
  return {
    reservation: {
      id: reservation?.id ?? null,
      name: reservation?.name ?? null,
      email: reservation?.email ?? null,
      date: reservation?.date ?? null,
      start_time: reservation?.start_time ?? null,
      end_time: reservation?.end_time ?? null,
      box_id: reservation?.box_id ?? null,
      persons: reservation?.persons ?? null,
      status: reservation?.status ?? null,
      montant: reservation?.montant ?? null,
      free_session: reservation?.free_session ?? false,
    },
    accessMode: "guest",
    rules: {
      modificationDeadlineHours: MODIFICATION_DEADLINE_HOURS,
      refundDeadlineHours: REFUND_DEADLINE_HOURS,
      canModify: isWithinModificationWindow(reservation.start_time),
      canRefund: isWithinRefundWindow(reservation.start_time),
    },
  };
}

function buildFullName(customer) {
  const prenom = String(customer?.prenom || "").trim();
  const nom = String(customer?.nom || "").trim();
  return `${prenom}${prenom && nom ? " " : ""}${nom}`.trim();
}

async function isFirstReservationForEmail(email) {
  const safeEmail = normalizeEmail(email);
  if (!safeEmail || !supabase) return null;

  const { data, error } = await supabase
    .from("reservations")
    .select("id, status")
    .eq("email", safeEmail)
    .limit(20);

  if (error) {
    console.error("Erreur vérification première réservation :", error);
    return null;
  }

  const activeReservations = (data || []).filter((row) => {
    const status = normalizeReservationStatus(row.status);
    return ![
      "cancelled",
      "annulee",
      "annulée",
      "refunded",
      "remboursee",
      "remboursée",
    ].includes(status);
  });

  return activeReservations.length === 0;
}

async function invalidateGuestManageToken(reservationId) {
  if (!supabase || !reservationId) return;

  try {
    await updateReservationById(reservationId, {
      guest_manage_token: generateGuestManageToken(),
      guest_manage_token_created_at: new Date().toISOString(),
      guest_manage_token_expires_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });
  } catch (e) {
    console.error("Erreur invalidation guest_manage_token :", e);
  }
}

async function createPendingModificationRequest({
  reservation,
  oldAmount,
  newAmount,
  deltaAmount,
  targetStart,
  targetEnd,
  safePersons,
  targetBoxId,
  stripePaymentIntentId = null,
  stripeClientSecret = null,
}) {
  const { data: modReq, error } = await supabase
    .from("reservation_modification_requests")
    .insert({
      reservation_id: reservation.id,
      guest_manage_token: reservation.guest_manage_token || null,

      old_start_time: reservation.start_time,
      old_end_time: reservation.end_time,
      old_persons: reservation.persons,
      old_amount: oldAmount,

      new_start_time: targetStart.toISOString(),
      new_end_time: targetEnd.toISOString(),
      new_persons: safePersons,
      new_amount: newAmount,
      delta_amount: deltaAmount,

      box_id: targetBoxId,
      status: "pending",
      stripe_payment_intent_id: stripePaymentIntentId,
      stripe_client_secret: stripeClientSecret,
      expires_at: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
    })
    .select()
    .single();

  if (error || !modReq) {
    console.error(
      "Erreur createPendingModificationRequest :",
      error || "insert vide"
    );
    return null;
  }

  return modReq;
}

async function attachPaymentIntentToModificationRequest({
  modReqId,
  paymentIntentId,
  clientSecret = null,
}) {
  if (!paymentIntentId || !modReqId) return false;

  try {
    await stripe.paymentIntents.update(paymentIntentId, {
      metadata: {
        type: "modification",
        modification_request_id: String(modReqId),
      },
    });

    const { error } = await supabase
      .from("reservation_modification_requests")
      .update({
        stripe_payment_intent_id: paymentIntentId,
        stripe_client_secret: clientSecret,
      })
      .eq("id", modReqId);

    if (error) {
      console.error("Erreur update modification request :", error);
      return false;
    }

    return true;
  } catch (err) {
    console.error("Erreur liaison PaymentIntent -> modification request :", err);
    return false;
  }
}

async function runReservationModification({
  reservation,
  userId = null,
  customer = null,
  newStartTime,
  newEndTime,
  newPersons,
  boxId,
  isGuest = false,
}) {
  if (!reservation) {
    return {
      ok: false,
      status: 404,
      body: { error: "Réservation introuvable" },
    };
  }

  if (!isReservationStatusModifiable(reservation.status)) {
    return {
      ok: false,
      status: 400,
      body: { error: "Statut de réservation non modifiable" },
    };
  }

  if (!isWithinModificationWindow(reservation.start_time)) {
    return {
      ok: false,
      status: 400,
      body: {
        error: `Modification impossible à moins de ${MODIFICATION_DEADLINE_HOURS}h avant la séance`,
      },
    };
  }

  const previousStartTime = reservation.start_time;
  const previousEndTime = reservation.end_time;
  const previousBoxId = Number(reservation.box_id || 1);
  const previousPersons = Number(reservation.persons || 2);

  const safePersons = clampPersons(newPersons || getReservationPersons(reservation));

  const currentStart = parseDateOrNull(reservation.start_time);
  const targetStart = parseDateOrNull(newStartTime || reservation.start_time);
  const targetEnd =
    parseDateOrNull(newEndTime) ||
    (targetStart
      ? new Date(targetStart.getTime() + SLOT_DURATION_MINUTES * 60 * 1000)
      : null);

  if (!currentStart || !targetStart || !targetEnd) {
    return {
      ok: false,
      status: 400,
      body: { error: "Nouveau créneau invalide" },
    };
  }

  if (!isWithinModificationWindow(targetStart.toISOString())) {
    return {
      ok: false,
      status: 400,
      body: {
        error: `Le nouveau créneau doit aussi être à plus de ${MODIFICATION_DEADLINE_HOURS}h de l'heure actuelle`,
      },
    };
  }

  const targetBoxId = Number(boxId || reservation.box_id || 1);
  const targetLocalDate = formatDateToYYYYMMDD(targetStart);

  const conflict = await hasReservationConflict({
    boxId: targetBoxId,
    startTime: targetStart.toISOString(),
    endTime: targetEnd.toISOString(),
    localDate: targetLocalDate,
    excludeReservationId: reservation.id,
  });

  if (conflict) {
    return {
      ok: false,
      status: 409,
      body: { error: "Le nouveau créneau n’est plus disponible" },
    };
  }

  const loyaltyUsed = isReservationPaidWithLoyalty(reservation);

  if (isGuest && loyaltyUsed) {
    return {
      ok: false,
      status: 409,
      body: {
        error:
          "Cette réservation liée aux Singcoins doit être modifiée depuis un compte connecté.",
      },
    };
  }

  const { oldAmount, newAmount, deltaAmount } = computeModificationDelta({
    reservation,
    targetStart,
    targetPersons: safePersons,
  });

  let autoChargeDone = false;
  let refundDone = false;
  let newPaymentIntentId = null;

  if (deltaAmount > 0) {
    if (isGuest || !userId) {
      const modReq = await createPendingModificationRequest({
        reservation,
        oldAmount,
        newAmount,
        deltaAmount,
        targetStart,
        targetEnd,
        safePersons,
        targetBoxId,
      });

      if (!modReq) {
        return {
          ok: false,
          status: 500,
          body: { error: "Erreur création modification" },
        };
      }

      const paymentIntent = await stripe.paymentIntents.create({
        amount: Math.round(deltaAmount * 100),
        currency: "eur",
        metadata: {
          type: "modification",
          modification_request_id: String(modReq.id),
        },
      });

      await supabase
        .from("reservation_modification_requests")
        .update({
          stripe_payment_intent_id: paymentIntent.id,
          stripe_client_secret: paymentIntent.client_secret,
        })
        .eq("id", modReq.id);

      return {
        ok: false,
        status: 200,
        body: {
          requiresPayment: true,
          clientSecret: paymentIntent.client_secret,
          amount: deltaAmount,
        },
      };
    }

    const autoCharge = await attemptAutomaticSavedCardCharge({
      userId,
      customer: customer || { email: reservation.email, prenom: "", nom: "" },
      amountEur: deltaAmount,
      metadata: {
        reservation_id: String(reservation.id),
        modification_delta_amount: String(deltaAmount),
        modification_type: "increase",
      },
    });

    if (!autoCharge.success) {
      if (autoCharge.clientSecret && autoCharge.paymentIntentId) {
        const modReq = await createPendingModificationRequest({
          reservation,
          oldAmount,
          newAmount,
          deltaAmount,
          targetStart,
          targetEnd,
          safePersons,
          targetBoxId,
          stripePaymentIntentId: autoCharge.paymentIntentId,
          stripeClientSecret: autoCharge.clientSecret,
        });

        if (!modReq) {
          return {
            ok: false,
            status: 500,
            body: { error: "Erreur création modification" },
          };
        }

        const linked = await attachPaymentIntentToModificationRequest({
          modReqId: modReq.id,
          paymentIntentId: autoCharge.paymentIntentId,
          clientSecret: autoCharge.clientSecret,
        });

        if (!linked) {
          return {
            ok: false,
            status: 500,
            body: {
              error: "Impossible de préparer le paiement de la modification.",
            },
          };
        }

        return {
          ok: false,
          status: 200,
          body: {
            requiresPayment: true,
            clientSecret: autoCharge.clientSecret,
            amount: deltaAmount,
          },
        };
      }

      return {
        ok: false,
        status: 409,
        body: {
          success: false,
          requiresAdditionalPayment: true,
          error:
            autoCharge.reason ||
            "Le débit automatique a échoué. Une authentification ou une nouvelle carte est requise.",
          clientSecret: autoCharge.clientSecret || null,
          paymentIntentId: autoCharge.paymentIntentId || null,
          financial: {
            oldAmount,
            newAmount,
            deltaAmount,
            loyaltyUsed,
          },
        },
      };
    }

    autoChargeDone = true;
    newPaymentIntentId = autoCharge.paymentIntent?.id || null;
  }

  if (deltaAmount < 0) {
    const refundAmount = Math.abs(deltaAmount);

    const refundResult = await attemptAutomaticRefundAcrossPaymentIntents(
      reservation,
      refundAmount
    );

    if (!refundResult.success) {
      return {
        ok: false,
        status: 500,
        body: {
          error:
            refundResult.reason ||
            "Impossible d’effectuer automatiquement le remboursement Stripe.",
          financial: {
            oldAmount,
            newAmount,
            deltaAmount,
            loyaltyUsed,
          },
        },
      };
    }

    refundDone = true;
  }

  const updatedReservation = await updateReservationById(reservation.id, {
    start_time: targetStart.toISOString(),
    end_time: targetEnd.toISOString(),
    date: targetLocalDate,
    datetime: targetStart.toISOString(),
    box_id: targetBoxId,
    persons: safePersons,
    billable_persons: Math.max(safePersons, 2),
    montant: newAmount,
    free_session: newAmount <= 0,
    loyalty_used: loyaltyUsed,
    points_spent: loyaltyUsed ? LOYALTY_POINTS_COST : 0,
    latest_payment_intent_id:
      newPaymentIntentId ||
      reservation.latest_payment_intent_id ||
      reservation.payment_intent_id ||
      reservation.original_payment_intent_id ||
      null,
    original_payment_intent_id:
      reservation.original_payment_intent_id ||
      reservation.payment_intent_id ||
      null,
    refunded_amount: roundMoney(
      Number(reservation.refunded_amount || 0) +
        (deltaAmount < 0 ? Math.abs(deltaAmount) : 0)
    ),
    last_auto_charge_amount: deltaAmount > 0 ? deltaAmount : 0,
    is_weekend: targetStart.getDay() === 0 || targetStart.getDay() === 6,
    is_daytime: targetStart.getHours() >= 12 && targetStart.getHours() < 18,
    is_group_session: safePersons >= 3,
    session_minutes: Math.floor((targetEnd - targetStart) / 60000),
    updated_at: new Date().toISOString(),
  });

  const scheduleChanged =
    previousStartTime !== updatedReservation.start_time ||
    previousEndTime !== updatedReservation.end_time ||
    previousBoxId !== Number(updatedReservation.box_id || 1);

  const personsChanged =
    previousPersons !== Number(updatedReservation.persons || 2);

  if (updatedReservation?.email && (scheduleChanged || personsChanged)) {
    try {
      await sendReservationModificationEmail(updatedReservation, {
        scheduleChanged,
        personsChanged,
        previousStartTime,
        previousEndTime,
      });
    } catch (mailErr) {
      console.error(
        "Erreur envoi email confirmation modification réservation :",
        mailErr
      );
    }
  }

  return {
    ok: true,
    status: 200,
    body: {
      success: true,
      message:
        deltaAmount > 0
          ? "Réservation modifiée avec débit automatique du supplément."
          : deltaAmount < 0
            ? "Réservation modifiée avec remboursement automatique."
            : "Réservation modifiée sans supplément ni remboursement.",
      reservation: updatedReservation,
      financial: {
        oldAmount,
        newAmount,
        deltaAmount,
        loyaltyUsed,
        autoChargeDone,
        refundDone,
      },
    },
  };
}

async function runReservationRefund({
  reservation,
  userId = null,
  isGuest = false,
}) {
  if (!reservation) {
    return {
      ok: false,
      status: 404,
      body: { error: "Réservation introuvable" },
    };
  }

  const start = parseDateOrNull(reservation.start_time);
  if (!start) {
    return {
      ok: false,
      status: 400,
      body: { error: "Date de réservation invalide" },
    };
  }

  if (!isWithinRefundWindow(reservation.start_time)) {
    return {
      ok: false,
      status: 400,
      body: {
        error: `Le remboursement n'est plus possible (moins de ${REFUND_DEADLINE_HOURS}h avant la séance).`,
      },
    };
  }

  const loyaltyUsed = isReservationPaidWithLoyalty(reservation);
  const loyaltyPointsToRefund = loyaltyUsed
    ? Number(getReservationLoyaltyPointsUsed(reservation))
    : 0;
  const cashAmountToRefund = Number(reservation.montant || 0);

  if (isGuest && loyaltyPointsToRefund > 0) {
    return {
      ok: false,
      status: 409,
      body: {
        error:
          "Cette réservation liée aux Singcoins doit être remboursée depuis un compte connecté.",
      },
    };
  }

  let stripeRefundDone = false;
  let loyaltyRefundDone = false;

  if (cashAmountToRefund > 0) {
    const refundResult = await attemptAutomaticRefundAcrossPaymentIntents(
      reservation,
      cashAmountToRefund
    );

    if (!refundResult.success) {
      return {
        ok: false,
        status: 500,
        body: {
          error:
            refundResult.reason ||
            "Impossible d’effectuer automatiquement le remboursement Stripe.",
        },
      };
    }

    stripeRefundDone = true;
  }

  if (loyaltyPointsToRefund > 0 && userId) {
    await refundPointsToUser(userId, loyaltyPointsToRefund);
    loyaltyRefundDone = true;
  }

  const updatedReservation = await updateReservationById(reservation.id, {
    status: "cancelled",
    cancelled_at: new Date().toISOString(),
    refunded_amount: roundMoney(
      Number(reservation.refunded_amount || 0) + cashAmountToRefund
    ),
    updated_at: new Date().toISOString(),
  });

  return {
    ok: true,
    status: 200,
    body: {
      success: true,
      message:
        loyaltyRefundDone && stripeRefundDone
          ? "Réservation annulée. Paiement remboursé et Singcoins recrédités."
          : loyaltyRefundDone
            ? "Réservation annulée. Les Singcoins ont été recrédités."
            : stripeRefundDone
              ? "Réservation annulée. Le paiement a été remboursé."
              : "Réservation annulée.",
      reservation: updatedReservation,
      stripeRefundDone,
      loyaltyRefundDone,
      loyaltyPointsRefunded: loyaltyPointsToRefund,
      cashRefundAmount: cashAmountToRefund,
    },
  };
}

router.post("/api/verify-cart", async (req, res) => {
  try {
    if (!supabase) {
      return res.status(500).send("Supabase non configuré");
    }

    const { items } = req.body || {};

    if (!items || !Array.isArray(items) || items.length === 0) {
      return res.status(400).send("Panier vide ou invalide");
    }

    const normalizedItems = [];

    for (const slot of items) {
      const times = buildTimesFromSlot(slot);
      const rawBox = slot.boxId ?? slot.box_id ?? slot.box ?? slot.boxName ?? 1;
      const numericBoxId = getNumericBoxId(rawBox);

      const hasConflict = await hasReservationConflict({
        boxId: numericBoxId,
        startTime: times.start_time,
        endTime: times.end_time,
        localDate: times.date,
      });

      if (hasConflict) {
        return res
          .status(409)
          .send(
            `Le créneau ${times.date} pour la box ${numericBoxId} n'est plus disponible.`
          );
      }

      const persons = clampPersons(slot.persons || slot.nb_personnes || 2);
      const startDate = new Date(times.start_time);
      const price =
        typeof slot.price === "number" && !Number.isNaN(slot.price)
          ? slot.price
          : computeSessionCashAmount(startDate, persons, { loyaltyUsed: false });

      normalizedItems.push({
        ...slot,
        price,
        box_id: numericBoxId,
        persons,
        start_time: times.start_time,
        end_time: times.end_time,
        date: times.date,
      });
    }

    return res.json({ items: normalizedItems });
  } catch (e) {
    console.error("Erreur /api/verify-cart :", e);
    return res.status(500).send("Erreur serveur lors de la vérification du panier");
  }
});

router.get("/api/my-reservations", authMiddleware, async (req, res) => {
  try {
    if (!supabase) {
      return res.status(500).json({ error: "Supabase non configuré" });
    }

    const { data: user, error: userError } = await supabase
      .from("users")
      .select("email")
      .eq("id", req.userId)
      .single();

    if (userError || !user) {
      console.error("Erreur lecture user pour my-reservations :", userError);
      return res.status(400).json({ error: "Utilisateur introuvable" });
    }

    const { data: reservations, error } = await supabase
      .from("reservations")
      .select(
        "id, name, email, date, start_time, end_time, box_id, persons, status, montant, free_session, created_at, checked_in_at, completed_at"
      )
      .or(`user_id.eq.${req.userId},email.eq.${user.email}`)
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

router.get("/api/my-reservations/:id", authMiddleware, async (req, res) => {
  try {
    if (!supabase) {
      return res.status(500).json({ error: "Supabase non configuré" });
    }

    const reservation = await getReservationOwnedByUser(req.params.id, req.userId);

    if (!reservation) {
      return res.status(404).json({ error: "Réservation introuvable" });
    }

    return res.json({ reservation });
  } catch (e) {
    console.error("Erreur /api/my-reservations/:id :", e);
    return res.status(500).json({ error: "Erreur serveur" });
  }
});

router.get("/api/guest-reservation", async (req, res) => {
  try {
    if (!supabase) {
      return res.status(500).json({ error: "Supabase non configuré" });
    }

    const token = String(req.query.token || "").trim();
    if (!token) {
      return res.status(400).json({ error: "token manquant" });
    }

    const reservation = await getReservationByGuestToken(token);

    if (!reservation) {
      return res.status(404).json({ error: "Lien de gestion invalide ou expiré" });
    }

    return res.json(buildGuestReservationResponse(reservation));
  } catch (e) {
    console.error("Erreur /api/guest-reservation :", e);
    return res.status(500).json({ error: "Erreur serveur" });
  }
});

router.post("/api/reservation-modification-options", authMiddleware, async (req, res) => {
  try {
    if (!supabase) {
      return res.status(500).json({ error: "Supabase non configuré" });
    }

    const { reservationId } = req.body || {};

    if (!reservationId) {
      return res.status(400).json({ error: "reservationId manquant" });
    }

    const reservation = await getReservationOwnedByUser(reservationId, req.userId);
    if (!reservation) {
      return res.status(404).json({ error: "Réservation introuvable" });
    }

    if (!isReservationStatusModifiable(reservation.status)) {
      return res.status(400).json({ error: "Statut de réservation non modifiable" });
    }

    if (!isWithinModificationWindow(reservation.start_time)) {
      return res.status(400).json({
        error: `Modification impossible à moins de ${MODIFICATION_DEADLINE_HOURS}h avant la séance`,
      });
    }

    const currentStart = parseDateOrNull(reservation.start_time);
    if (!currentStart) {
      return res.status(400).json({ error: "Date de réservation invalide" });
    }

    const reservationDate = reservation.date || formatDateToYYYYMMDD(currentStart);
    const boxId = reservation.box_id;
    const currentPersons = getReservationPersons(reservation);
    const loyaltyUsed = isReservationPaidWithLoyalty(reservation);

    const options = [];

    for (const slotHour of STANDARD_SLOT_STARTS) {
      const { startIso, endIso } = buildSlotIsoRange(reservationDate, slotHour);
      const startDate = new Date(startIso);

      if (Math.abs(startDate.getTime() - currentStart.getTime()) < 60 * 1000) {
        continue;
      }

      if (!isWithinModificationWindow(startIso)) {
        continue;
      }

      const conflict = await hasReservationConflict({
        boxId,
        startTime: startIso,
        endTime: endIso,
        localDate: reservationDate,
        excludeReservationId: reservation.id,
      });

      if (conflict) {
        continue;
      }

      options.push({
        startTime: startIso,
        endTime: endIso,
        boxId,
        boxName: `Box ${boxId}`,
        estimatedAmount: computeSessionCashAmount(startDate, currentPersons, {
          loyaltyUsed,
        }),
      });
    }

    return res.json({
      reservationId: reservation.id,
      options,
      loyaltyUsed,
      currentPersons,
      loyaltyPointsUsed: getReservationLoyaltyPointsUsed(reservation),
      slotStarts: STANDARD_SLOT_STARTS,
    });
  } catch (e) {
    console.error("Erreur /api/reservation-modification-options :", e);
    return res.status(500).json({ error: "Erreur serveur" });
  }
});

router.post("/api/modify-reservation", authMiddleware, async (req, res) => {
  try {
    if (!supabase) {
      return res.status(500).json({ error: "Supabase non configuré" });
    }

    const {
      reservationId,
      newStartTime,
      newEndTime,
      newPersons,
      boxId,
      customer,
    } = req.body || {};

    if (!reservationId) {
      return res.status(400).json({ error: "reservationId manquant" });
    }

    const reservation = await getReservationOwnedByUser(reservationId, req.userId);
    const result = await runReservationModification({
      reservation,
      userId: req.userId,
      customer,
      newStartTime,
      newEndTime,
      newPersons,
      boxId,
      isGuest: false,
    });

    return res.status(result.status).json(result.body);
  } catch (e) {
    console.error("Erreur /api/modify-reservation :", e);
    return res
      .status(500)
      .json({ error: "Erreur serveur lors de la modification" });
  }
});

router.post("/api/guest-modify-reservation", async (req, res) => {
  try {
    if (!supabase) {
      return res.status(500).json({ error: "Supabase non configuré" });
    }

    const { token, newStartTime, newEndTime, newPersons, boxId } = req.body || {};

    const safeToken = String(token || "").trim();
    if (!safeToken) {
      return res.status(400).json({ error: "token manquant" });
    }

    const reservation = await getReservationByGuestToken(safeToken);
    const result = await runReservationModification({
      reservation,
      userId: null,
      customer: { email: reservation?.email || null, prenom: "", nom: "" },
      newStartTime,
      newEndTime,
      newPersons,
      boxId,
      isGuest: true,
    });

    return res.status(result.status).json(result.body);
  } catch (e) {
    console.error("Erreur /api/guest-modify-reservation :", e);
    return res
      .status(500)
      .json({ error: "Erreur serveur lors de la modification" });
  }
});

router.post("/api/confirm-reservation", async (req, res) => {
  let userIdFromToken = null;
  let loyaltyPointsDebited = false;
  let loyaltyPointsDebitedAmount = 0;

  try {
    const { panier, customer, promoCode, paymentIntentId, loyaltyUsed } =
      req.body || {};

    if (!panier || !Array.isArray(panier) || panier.length === 0) {
      return res.status(400).json({ error: "Panier vide" });
    }

    const normalizedCustomerEmail = normalizeEmail(customer?.email);
    const fullName = buildFullName(customer);

    if (!normalizedCustomerEmail) {
      return res.status(400).json({ error: "Email client manquant" });
    }

    if (!fullName) {
      return res.status(400).json({ error: "Nom client manquant" });
    }

    const pricing = computeCartPricing(panier, { loyaltyUsed: !!loyaltyUsed });
    const theoreticalTotal = pricing.totalBeforeDiscount;
    const loyaltyDiscount = pricing.loyaltyDiscount;
    let totalCashDue = pricing.totalCashDue;

    let promoDiscountAmount = 0;
    let promo = null;

    if (promoCode) {
      const isFirstSession = normalizedCustomerEmail
        ? await isFirstReservationForEmail(normalizedCustomerEmail)
        : null;

      const result = await validatePromoCode(promoCode, totalCashDue, {
        email: normalizedCustomerEmail || null,
        isFirstSession,
        enforceAdvancedRules: true,
      });

      if (!result.ok) {
        return res.status(400).json({
          error: result.reason || "Code promo invalide",
          promo: result.promoPublic || result.promo || null,
        });
      }

      totalCashDue = result.newTotal;
      promoDiscountAmount = result.discountAmount;
      promo = result.promo;
    }

    const isFreeReservationFlag = totalCashDue <= 0;

    try {
      const authHeader = req.headers.authorization;
      const token = authHeader?.startsWith("Bearer ")
        ? authHeader.split(" ")[1]
        : null;
      if (token) {
        const decoded = jwt.verify(token, JWT_SECRET);
        userIdFromToken = decoded.userId;
      }
    } catch (e) {
      console.warn("⚠️ Token invalide sur /api/confirm-reservation :", e.message);
    }

    if (loyaltyUsed && !userIdFromToken) {
      return res.status(401).json({
        error: "Connexion requise pour utiliser les Singcoins",
      });
    }

    if (!isFreeReservationFlag) {
      if (!paymentIntentId) {
        return res.status(400).json({ error: "paymentIntentId manquant" });
      }

      if (!stripe) {
        return res.status(500).json({ error: "Stripe non configuré" });
      }

      const alreadyUsedEarly = await isPaymentIntentAlreadyUsed(paymentIntentId);
      if (alreadyUsedEarly) {
        return res.status(409).json({
          error: "Ce paiement a déjà été utilisé pour une réservation",
        });
      }

      const pi = await stripe.paymentIntents.retrieve(paymentIntentId);

      if (pi.status !== "succeeded") {
        return res.status(400).json({ error: "Paiement non validé par Stripe" });
      }

      const expectedAmountCents = Math.round(Number(totalCashDue || 0) * 100);
      const paidAmountCents = Number(pi.amount_received || pi.amount || 0);

      if (paidAmountCents !== expectedAmountCents) {
        return res.status(400).json({
          error: "Montant Stripe incohérent avec le total calculé côté serveur",
          expectedAmountCents,
          paidAmountCents,
        });
      }
    }

    if (!supabase) {
      return res.json({ status: "ok (sans enregistrement Supabase)" });
    }

    if (loyaltyUsed) {
      const loyaltyConsume = await consumeLoyaltyPointsForUser(
        userIdFromToken,
        LOYALTY_POINTS_COST
      );

      if (!loyaltyConsume.success) {
        return res.status(400).json({
          error: loyaltyConsume.reason || "Pas assez de Singcoins",
          currentSingcoins: loyaltyConsume.currentPoints ?? null,
          requiredSingcoins: loyaltyConsume.requiredPoints ?? LOYALTY_POINTS_COST,
        });
      }

      loyaltyPointsDebited = true;
      loyaltyPointsDebitedAmount = LOYALTY_POINTS_COST;
    }

    try {
      if (userIdFromToken && customer) {
        await updateUserProfileInUsersTable(userIdFromToken, customer);
      }
    } catch (e) {
      console.warn(
        "⚠️ update users (confirm-reservation) a échoué:",
        e.message
      );
    }

    const rows = pricing.normalizedItems.map((it) => {
      const start = new Date(it.start_time);
      const end = new Date(it.end_time);

      const hour = start.getHours();
      const day = start.getDay();

      return {
        name: fullName,
        email: normalizedCustomerEmail,
        user_id: userIdFromToken || null,

        datetime: start.toISOString(),
        start_time: start.toISOString(),
        end_time: end.toISOString(),
        date: it.date,

        box_id: it.box_id,
        status: "confirmed",

        persons: it.persons,
        billable_persons: Math.max(it.persons, 2),
        montant: totalCashDue,

        free_session: totalCashDue <= 0,
        loyalty_used: !!loyaltyUsed,
        points_spent: loyaltyUsed ? LOYALTY_POINTS_COST : 0,

        payment_intent_id: paymentIntentId || null,
        original_payment_intent_id: paymentIntentId || null,
        latest_payment_intent_id: paymentIntentId || null,
        deposit_payment_intent_id: null,
        deposit_amount_cents: null,
        deposit_status: null,

        checked_in_at: null,
        completed_at: null,
        cancelled_at: null,
        refunded_at: null,

        is_weekend: day === 0 || day === 6,
        is_daytime: hour >= 12 && hour < 18,
        is_group_session: it.persons >= 3,
        session_minutes: Math.floor((end - start) / 60000),
        updated_at: new Date().toISOString(),
      };
    });

    for (const row of rows) {
      const hasConflict = await hasReservationConflict({
        boxId: row.box_id,
        startTime: row.start_time,
        endTime: row.end_time,
        localDate: row.date,
      });

      if (hasConflict) {
        if (loyaltyPointsDebited && userIdFromToken && loyaltyPointsDebitedAmount > 0) {
          await refundPointsToUser(userIdFromToken, loyaltyPointsDebitedAmount);
        }

        return res.status(409).json({
          error: "Ce créneau est déjà réservé pour la box " + row.box_id + ".",
        });
      }
    }

    if (!isFreeReservationFlag && paymentIntentId) {
      const alreadyUsedLate = await isPaymentIntentAlreadyUsed(paymentIntentId);
      if (alreadyUsedLate) {
        if (loyaltyPointsDebited && userIdFromToken && loyaltyPointsDebitedAmount > 0) {
          await refundPointsToUser(userIdFromToken, loyaltyPointsDebitedAmount);
        }

        return res.status(409).json({
          error: "Ce paiement a déjà été utilisé pour une réservation",
        });
      }
    }

    const insertedReservations = [];
    for (const row of rows) {
      const { data, error } = await supabase
        .from("reservations")
        .insert(row)
        .select()
        .single();

      if (error) {
        if (loyaltyPointsDebited && userIdFromToken && loyaltyPointsDebitedAmount > 0) {
          await refundPointsToUser(userIdFromToken, loyaltyPointsDebitedAmount);
        }

        console.error("Erreur Supabase insert reservations :", error);
        return res
          .status(500)
          .json({ error: "Erreur en enregistrant la réservation" });
      }

      insertedReservations.push(data);
    }

    try {
      await Promise.allSettled(
        insertedReservations.map((row) => sendReservationEmail(row))
      );
    } catch (mailErr) {
      console.error("Erreur globale envoi mails :", mailErr);
    }

    try {
      const isActuallyFree = totalCashDue <= 0;
      if (userIdFromToken && !isActuallyFree) {
        const singcoinsToAdd = insertedReservations.length * 10;

        await creditSingcoins({
          userId: userIdFromToken,
          amount: singcoinsToAdd,
          type: "reservation_purchase_reward",
          referenceType: "payment_intent",
          referenceId: paymentIntentId || insertedReservations.map((r) => String(r.id)).join(","),
          label: `${insertedReservations.length} réservation(s) payée(s)`,
        });
      }
    } catch (singcoinsErr) {
      console.error("Erreur lors de l'ajout automatique des Singcoins :", singcoinsErr);
    }

    try {
      if (promo && promoDiscountAmount > 0) {
        const totalAfterDiscount = Math.max(0, totalCashDue);
        const currentUsed = Number(promo.used_count || 0);

        const { data: updatedPromoRows, error: promoUpdateError } = await supabase
          .from("promo_codes")
          .update({ used_count: currentUsed + 1 })
          .eq("id", promo.id)
          .eq("used_count", currentUsed)
          .select("id, used_count");

        if (promoUpdateError) {
          throw promoUpdateError;
        }

        if (!updatedPromoRows || updatedPromoRows.length === 0) {
          throw new Error(
            "Le code promo a été utilisé en même temps par une autre requête"
          );
        }

        const { error: promoUsageError } = await supabase
          .from("promo_usages")
          .insert({
            promo_id: promo.id,
            code: promo.code,
            email: normalizedCustomerEmail || null,
            payment_intent_id: paymentIntentId || null,
            total_before: pricing.totalCashDue,
            total_after: totalAfterDiscount,
            discount_amount: promoDiscountAmount,
          });

        if (promoUsageError) {
          console.error("Erreur insert promo_usages :", promoUsageError);
        }
      }
    } catch (promoErr) {
      console.error("Erreur promo usages :", promoErr);
    }

    let gamification = null;
    if (userIdFromToken) {
      try {
        gamification = await getUserGamificationSnapshot(userIdFromToken);
      } catch (e) {
        console.error("Erreur snapshot gamification après réservation :", e);
      }
    }

    return res.json({
      status: "ok",
      reservations: insertedReservations,
      pricing: {
        totalBeforeDiscount: theoreticalTotal,
        loyaltyDiscount,
        promoDiscountAmount,
        totalAfterDiscount: totalCashDue,
      },
      loyalty: {
        used: !!loyaltyUsed,
        pointsSpent: loyaltyUsed ? loyaltyPointsDebitedAmount : 0,
      },
      promo: promo
        ? {
            code: promo.code,
            discountAmount: promoDiscountAmount,
            totalBefore: pricing.totalCashDue,
            totalAfter: totalCashDue,
          }
        : null,
      gamification,
    });
  } catch (err) {
    if (loyaltyPointsDebited && userIdFromToken && loyaltyPointsDebitedAmount > 0) {
      try {
        await refundPointsToUser(userIdFromToken, loyaltyPointsDebitedAmount);
      } catch (refundErr) {
        console.error(
          "❌ Impossible de recréditer les Singcoins après échec :",
          refundErr
        );
      }
    }

    console.error("Erreur confirm-reservation :", err);
    return res
      .status(500)
      .json({ error: "Erreur serveur lors de la réservation" });
  }
});

router.post("/api/refund-reservation", authMiddleware, async (req, res) => {
  try {
    if (!supabase) {
      return res.status(500).json({ error: "Supabase non configuré" });
    }

    const { reservationId } = req.body || {};
    if (!reservationId) {
      return res.status(400).json({ error: "reservationId manquant" });
    }

    const reservation = await getReservationOwnedByUser(reservationId, req.userId);
    const result = await runReservationRefund({
      reservation,
      userId: req.userId,
      isGuest: false,
    });

    return res.status(result.status).json(result.body);
  } catch (e) {
    console.error("Erreur /api/refund-reservation :", e);
    return res
      .status(500)
      .json({ error: "Erreur serveur lors du remboursement" });
  }
});

router.post("/api/guest-refund-reservation", async (req, res) => {
  try {
    if (!supabase) {
      return res.status(500).json({ error: "Supabase non configuré" });
    }

    const { token } = req.body || {};
    const safeToken = String(token || "").trim();

    if (!safeToken) {
      return res.status(400).json({ error: "token manquant" });
    }

    const reservation = await getReservationByGuestToken(safeToken);
    const result = await runReservationRefund({
      reservation,
      userId: null,
      isGuest: true,
    });

    if (result.ok && reservation?.id) {
      await invalidateGuestManageToken(reservation.id);
    }

    return res.status(result.status).json(result.body);
  } catch (e) {
    console.error("Erreur /api/guest-refund-reservation :", e);
    return res
      .status(500)
      .json({ error: "Erreur serveur lors du remboursement" });
  }
});

export default router;