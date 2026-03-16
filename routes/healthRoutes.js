// backend/routes/healthRoutes.js

import express from "express";

const router = express.Router();

router.get("/", (_req, res) => {
  res.send("API Singbox OK");
});

router.get("/api/health", (_req, res) => {
  res.json({ ok: true });
});

export default router;