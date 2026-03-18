// backend/routes/webhookRoutes.js

import express from "express";
import bodyParser from "body-parser";

import { stripe } from "../config/stripe.js";
import { STRIPE_WEBHOOK_SECRET } from "../config/env.js";
import { supabase } from "../config/supabase.js";
import { applyReservationModification } from "../services/reservationService.js";

const router = express.Router();

router.post(
  "/api/webhook",
  bodyParser.raw({ type: "application/json" }),
  async (req, res) => {
    const sig = req.headers["stripe-signature"];

    let event;

    try {
      event = stripe.webhooks.constructEvent(req.body, sig, STRIPE_WEBHOOK_SECRET);
    } catch (err) {
      console.error("❌ Webhook error:", err.message);
      return res.status(400).send();
    }

    try {
      if (event.type === "payment_intent.succeeded") {
        const intent = event.data.object;

        if (intent.metadata?.type === "modification") {
          const modId = intent.metadata.modification_request_id;

          const { data: modReq, error: modReqError } = await supabase
            .from("reservation_modification_requests")
            .select("*")
            .eq("id", modId)
            .single();

          if (modReqError) {
            console.error("Erreur récupération modification request :", modReqError);
            return res.json({ received: true });
          }

          if (modReq && modReq.status !== "applied") {
            try {
              await applyReservationModification({
                ...modReq,
                stripe_payment_intent_id: modReq.stripe_payment_intent_id || intent.id,
              });

              await supabase
                .from("reservation_modification_requests")
                .update({
                  status: "applied",
                  stripe_payment_intent_id: modReq.stripe_payment_intent_id || intent.id,
                })
                .eq("id", modId);
            } catch (applyErr) {
              console.error("Erreur application modification :", applyErr);

              await supabase
                .from("reservation_modification_requests")
                .update({
                  status: "failed",
                })
                .eq("id", modId);
            }
          }
        }
      }

      return res.json({ received: true });
    } catch (err) {
      console.error("Webhook processing error:", err);
      return res.sendStatus(500);
    }
  }
);

export default router;