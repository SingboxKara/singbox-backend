// backend/config/stripe.js

import Stripe from "stripe";
import { STRIPE_SECRET_KEY } from "./env.js";

export const stripe = STRIPE_SECRET_KEY
  ? new Stripe(STRIPE_SECRET_KEY, {
      apiVersion: "2023-10-16",
    })
  : null;