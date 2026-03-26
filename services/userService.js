// backend/routes/publicRoutes.js

import express from "express";

import { supabase } from "../config/supabase.js";
import { VACANCES_ZONE_C } from "../constants/holidays.js";
import { getHomeLeaderboards } from "../services/leaderboardService.js";
import {
  isDateInRange,
  addDaysToDateString,
  parseDateOrNull,
} from "../utils/dates.js";
import {
  isReservationStatusConfirmed,
  isReservationStatusCancelledOrRefunded,
} from "../services/reservationService.js";
import {
  STANDARD_SLOT_STARTS,
  buildSlotIsoRange,
} from "../services/pricingService.js";

const router = express.Router();

function safeText(value, maxLen = 120) {
  return String(value || "").trim().slice(0, maxLen);
}

function isValidDateOnly(dateStr) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(dateStr || "").trim());
}

router.get("/api/is-vacances", (req, res) => {
  const date = safeText(req.query.date, 20);

  if (!date) {
    return res
      .status(400)
      .json({ error: "Paramètre 'date' manquant (YYYY-MM-DD)" });
  }

  if (!isValidDateOnly(date)) {
    return res
      .status(400)
      .json({ error: "Paramètre 'date' invalide (YYYY-MM-DD attendu)" });
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

  const date = safeText(req.query.date, 20);

  if (!date) {
    return res
      .status(400)
      .json({ error: "Paramètre 'date' manquant (YYYY-MM-DD)" });
  }

  if (!isValidDateOnly(date)) {
    return res
      .status(400)
      .json({ error: "Paramètre 'date' invalide (YYYY-MM-DD attendu)" });
  }

  try {
    const previousDate = addDaysToDateString(date, -1);
    const nextDate = addDaysToDateString(date, 1);

    const { data, error } = await supabase
      .from("reservations")
      .select("id, box_id, start_time, end_time, status, date")
      .in("date", [previousDate, date, nextDate]);

    if (error) {
      console.error("Erreur /api/slots Supabase :", error);
      return res.status(500).json({ error: "Erreur serveur Supabase" });
    }

    const { startIso: dayStartIso } = buildSlotIsoRange(date, 0);
    const nextDayStartDate = parseDateOrNull(
      buildSlotIsoRange(nextDate, 0).startIso
    );

    const dayStart = parseDateOrNull(dayStartIso);
    const dayEnd = nextDayStartDate
      ? new Date(nextDayStartDate.getTime() - 1)
      : null;

    if (!dayStart || !dayEnd) {
      return res.status(500).json({
        error: "Impossible de construire la fenêtre journalière",
      });
    }

    const reservations = (data || []).filter((row) => {
      if (!isReservationStatusConfirmed(row.status)) return false;

      const start = parseDateOrNull(row.start_time);
      const end = parseDateOrNull(row.end_time);

      if (!start || !end) return false;

      return (
        start.getTime() <= dayEnd.getTime() &&
        end.getTime() > dayStart.getTime()
      );
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
    return res
      .status(500)
      .json({ valid: false, error: "Supabase non configuré" });
  }

  try {
    const id = safeText(req.query.id, 120);

    if (!id) {
      return res.status(400).json({ valid: false, error: "Missing id" });
    }

    const { data, error } = await supabase
      .from("reservations")
      .select("*")
      .eq("id", id)
      .single();

    if (error || !data) {
      return res
        .status(404)
        .json({ valid: false, reason: "Réservation introuvable." });
    }

    const now = new Date();
    const start = parseDateOrNull(data.start_time);
    const end = parseDateOrNull(data.end_time);

    if (!start || !end) {
      return res.status(500).json({
        valid: false,
        error: "Horaires de réservation invalides",
      });
    }

    const marginBeforeMinutes = 5;
    const marginBeforeEndMinutes = 5;

    const startWithMargin = new Date(
      start.getTime() - marginBeforeMinutes * 60000
    );
    const lastEntryTime = new Date(
      end.getTime() - marginBeforeEndMinutes * 60000
    );

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
    return res.status(500).json({ valid: false, error: e.message });
  }
});

router.get("/api/leaderboards/home", async (req, res) => {
  try {
    const limit = req.query.limit;
    const leaderboards = await getHomeLeaderboards(limit);

    return res.json({
      ok: true,
      ...leaderboards,
    });
  } catch (e) {
    console.error("Erreur /api/leaderboards/home :", e);
    return res.status(500).json({
      ok: false,
      error: "Impossible de charger les leaderboards.",
    });
  }
});

export default router;
