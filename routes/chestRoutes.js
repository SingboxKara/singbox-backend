// backend/routes/chestRoutes.js

import express from "express";

import { authMiddleware } from "../middlewares/auth.js";
import {
  getChestStateForUser,
  openChestForUser,
} from "../services/chestRewardService.js";

const router = express.Router();

router.get("/api/chest/state", authMiddleware, async (req, res) => {
  try {
    const state = await getChestStateForUser(req.userId);
    return res.json({
      success: true,
      state,
    });
  } catch (error) {
    console.error("Erreur /api/chest/state :", error);
    return res.status(500).json({
      success: false,
      error: "Erreur serveur lors de la lecture du coffre",
    });
  }
});

router.post("/api/chest/open", authMiddleware, async (req, res) => {
  try {
    const result = await openChestForUser(req.userId);

    if (!result.ok) {
      return res.status(409).json({
        success: false,
        error: result.reason || "Impossible d’ouvrir le coffre",
        state: result.state || null,
        reward: result.reward || null,
      });
    }

    return res.json({
      success: true,
      reward: result.reward,
      state: result.state,
    });
  } catch (error) {
    console.error("Erreur /api/chest/open :", error);
    return res.status(500).json({
      success: false,
      error: "Erreur serveur lors de l’ouverture du coffre",
    });
  }
});

export default router;