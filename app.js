// backend/app.js

import express from "express";
import cors from "cors";
import bodyParser from "body-parser";

import webhookRoutes from "./routes/webhookRoutes.js";
import healthRoutes from "./routes/healthRoutes.js";
import publicRoutes from "./routes/publicRoutes.js";
import authRoutes from "./routes/authRoutes.js";
import userRoutes from "./routes/userRoutes.js";
import paymentRoutes from "./routes/paymentRoutes.js";
import reservationRoutes from "./routes/reservationRoutes.js";
import reviewRoutes from "./routes/reviewRoutes.js";
import adminRoutes from "./routes/adminRoutes.js";

const app = express();

app.use(
  cors({
    origin: "*",
  })
);

console.log("🌍 CORS autorise l'origine : *");

// Important : webhook avant bodyParser.json()
app.use(webhookRoutes);

app.use(bodyParser.json());
console.log("🌍 CORS + JSON configurés");

app.use(healthRoutes);
app.use(publicRoutes);
app.use(authRoutes);
app.use(userRoutes);
app.use(paymentRoutes);
app.use(reservationRoutes);
app.use(reviewRoutes);
app.use(adminRoutes);

export default app;