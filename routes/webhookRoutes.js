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

          const { data: modReq } = await supabase
            .from("reservation_modification_requests")
            .select("*")
            .eq("id", modId)
            .single();

          if (modReq && modReq.status !== "applied") {

            await applyReservationModification(modReq);

            await supabase
              .from("reservation_modification_requests")
              .update({
                status: "applied",
                paid_at: new Date(),
                applied_at: new Date(),
              })
              .eq("id", modId);
          }
        }
      }

      res.json({ received: true });

    } catch (err) {
      console.error("Webhook processing error:", err);
      res.sendStatus(500);
    }
  }
);

export default router;