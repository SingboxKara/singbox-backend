// backend/routes/publicRoutes.js

import express from "express";

import { supabase } from "../config/supabase.js";
import { VACANCES_ZONE_C } from "../constants/holidays.js";
import { isDateInRange, addDaysToDateString, parseDateOrNull } from "../utils/dates.js";
import {
  isReservationStatusConfirmed,
  isReservationStatusCancelledOrRefunded,
} from "../services/reservationService.js";
import { STANDARD_SLOT_STARTS } from "../services/pricingService.js";

const router = express.Router();

router.get("/api/is-vacances", (req, res) => {
  const date = req.query.date;
  if (!date) {
    return res.status(400).json({ error: "Paramètre 'date' manquant (YYYY-MM-DD)" });
  }

  const matchingPeriods = VACANCES_ZONE_C.filter((p) =>
    isDateInRange(date, p.start, p.end)
  );
  const isHoliday = matchingPeriods.length > 0;

  return res.json({
    vacances: isHoliday,
    is_vacances: isHoliday,
    zone: "C",
    date,
    periods: matchingPeriods,
  });
});

router.get("/api/slots", async (req, res) => {
  if (!supabase) {
    return res.status(500).json({ error: "Supabase non configuré" });
  }

  const date = req.query.date;
  if (!date) {
    return res.status(400).json({ error: "Paramètre 'date' manquant (YYYY-MM-DD)" });
  }

  try {
    const previousDate = addDaysToDateString(date, -1);

    const { data, error } = await supabase
      .from("reservations")
      .select("id, box_id, start_time, end_time, status, date")
      .in("date", [date, previousDate]);

    if (error) {
      console.error("Erreur /api/slots Supabase :", error);
      return res.status(500).json({ error: "Erreur serveur Supabase" });
    }

    const dayStart = new Date(`${date}T00:00:00+01:00`);
    const dayEnd = new Date(`${date}T23:59:59+01:00`);

    const reservations = (data || []).filter((row) => {
      if (!isReservationStatusConfirmed(row.status)) return false;

      const start = parseDateOrNull(row.start_time);
      const end = parseDateOrNull(row.end_time);
      if (!start || !end) return false;

      return start.getTime() <= dayEnd.getTime() && end.getTime() > dayStart.getTime();
    });

    return res.json({
      reservations,
      slotStarts: STANDARD_SLOT_STARTS,
    });
  } catch (e) {
    console.error("Erreur /api/slots :", e);
    return res.status(500).json({ error: "Erreur serveur" });
  }
});

router.get("/api/check", async (req, res) => {
  if (!supabase) {
    return res.status(500).json({ valid: false, error: "Supabase non configuré" });
  }

  try {
    const id = req.query.id;

    if (!id) {
      res.status(400);
      return res.json({ valid: false, error: "Missing id" });
    }

    const { data, error } = await supabase
      .from("reservations")
      .select("*")
      .eq("id", id)
      .single();

    if (error || !data) {
      res.status(404);
      return res.json({ valid: false, reason: "Réservation introuvable." });
    }

    const now = new Date();
    const start = new Date(data.start_time);
    const end = new Date(data.end_time);

    const marginBeforeMinutes = 5;
    const marginBeforeEndMinutes = 5;

    const startWithMargin = new Date(start.getTime() - marginBeforeMinutes * 60000);
    const lastEntryTime = new Date(end.getTime() - marginBeforeEndMinutes * 60000);

    let access = false;
    let reason = "OK";

    if (isReservationStatusCancelledOrRefunded(data.status)) {
      access = false;
      reason = "Réservation annulée ou remboursée, accès refusé.";
    } else if (now < startWithMargin) {
      access = false;
      reason = "Trop tôt pour accéder à la box.";
    } else if (now > lastEntryTime) {
      access = false;
      reason = "Créneau terminé, accès refusé.";
    } else if (!isReservationStatusConfirmed(data.status)) {
      access = false;
      reason = `Statut invalide : ${data.status}`;
    } else {
      access = true;
      reason = "Créneau valide, accès autorisé.";
    }

    return res.json({ valid: true, access, reason, reservation: data });
  } catch (e) {
    console.error("Erreur /api/check :", e);
    res.status(500);
    return res.json({ valid: false, error: e.message });
  }
});

export default router;