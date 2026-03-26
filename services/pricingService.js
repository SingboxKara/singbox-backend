// backend/services/pricingService.js

import {
  SLOT_DURATION_MINUTES,
  MIN_BILLABLE_PERSONS,
  SINGCOINS_FREE_BILLABLE_PERSONS,
  WEEKDAY_MORNING_RATE,
  WEEKDAY_MIDDAY_RATE,
  WEEKDAY_EVENING_RATE,
  WEEKEND_BEFORE_15_RATE,
  WEEKEND_AFTER_15_RATE,
  WEEKDAY_MORNING_START_HOUR,
  WEEKDAY_MIDDAY_START_HOUR,
  WEEKDAY_EVENING_START_HOUR,
  WEEKDAY_END_NIGHT_HOUR,
  WEEKEND_AFTERNOON_SWITCH_HOUR,
} from "../constants/booking.js";

import { clampPersons, getNumericBoxId } from "../utils/validators.js";
import { isReservationPaidWithSingcoins } from "./singcoinService.js";

const PARIS_TIME_ZONE = "Europe/Paris";

function toSafeInt(value, fallback = 0) {
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) ? n : fallback;
}

function parseDateOnly(dateStr) {
  const match = String(dateStr || "").match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) {
    throw new Error("Date invalide (format attendu YYYY-MM-DD)");
  }

  return {
    year: toSafeInt(match[1]),
    month: toSafeInt(match[2]),
    day: toSafeInt(match[3]),
  };
}

function getParisFormatter(options = {}) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: PARIS_TIME_ZONE,
    hourCycle: "h23",
    ...options,
  });
}

function getParisDateParts(date) {
  const formatter = getParisFormatter({
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });

  const parts = formatter.formatToParts(date);
  const map = Object.fromEntries(parts.map((part) => [part.type, part.value]));

  return {
    year: toSafeInt(map.year),
    month: toSafeInt(map.month),
    day: toSafeInt(map.day),
    hour: toSafeInt(map.hour),
    minute: toSafeInt(map.minute),
    second: toSafeInt(map.second),
  };
}

function getParisWeekday(date) {
  const formatter = getParisFormatter({ weekday: "short" });
  const weekday = formatter.format(date).toLowerCase();

  if (weekday.startsWith("mon")) return 1;
  if (weekday.startsWith("tue")) return 2;
  if (weekday.startsWith("wed")) return 3;
  if (weekday.startsWith("thu")) return 4;
  if (weekday.startsWith("fri")) return 5;
  if (weekday.startsWith("sat")) return 6;
  return 0;
}

function getOffsetMinutesForParis(date) {
  const formatter = getParisFormatter({
    timeZoneName: "shortOffset",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });

  const parts = formatter.formatToParts(date);
  const tzName = parts.find((part) => part.type === "timeZoneName")?.value || "";
  const normalized = tzName.replace(/\u2212/g, "-");
  const match = normalized.match(/GMT([+-])(\d{1,2})(?::?(\d{2}))?/i);

  if (!match) {
    return 60;
  }

  const sign = match[1] === "-" ? -1 : 1;
  const hours = toSafeInt(match[2], 0);
  const minutes = toSafeInt(match[3], 0);

  return sign * (hours * 60 + minutes);
}

function formatOffset(minutes) {
  const sign = minutes < 0 ? "-" : "+";
  const abs = Math.abs(minutes);
  const hh = String(Math.floor(abs / 60)).padStart(2, "0");
  const mm = String(abs % 60).padStart(2, "0");
  return `${sign}${hh}:${mm}`;
}

function formatIsoInParis(date) {
  const parts = getParisDateParts(date);
  const offset = formatOffset(getOffsetMinutesForParis(date));

  return `${String(parts.year).padStart(4, "0")}-${String(parts.month).padStart(2, "0")}-${String(parts.day).padStart(2, "0")}T${String(parts.hour).padStart(2, "0")}:${String(parts.minute).padStart(2, "0")}:${String(parts.second).padStart(2, "0")}${offset}`;
}

function formatDateOnlyInParis(date) {
  const parts = getParisDateParts(date);
  return `${String(parts.year).padStart(4, "0")}-${String(parts.month).padStart(2, "0")}-${String(parts.day).padStart(2, "0")}`;
}

function buildUtcDateFromParisLocal(dateStr, hour, minute = 0) {
  const { year, month, day } = parseDateOnly(dateStr);

  const roughUtc = new Date(Date.UTC(year, month - 1, day, hour, minute, 0));
  const offsetMinutes = getOffsetMinutesForParis(roughUtc);

  return new Date(Date.UTC(year, month - 1, day, hour, minute, 0) - offsetMinutes * 60 * 1000);
}

function parseHourValue(rawHour) {
  let hourNum = 0;
  let minuteNum = 0;

  if (typeof rawHour === "number") {
    hourNum = Math.floor(rawHour);
    minuteNum = Math.round((rawHour - hourNum) * 60);
  } else {
    const m = String(rawHour || "").match(/(\d{1,2})[h:]?(\d{2})?/);
    if (!m) {
      throw new Error("Heure de créneau invalide");
    }

    hourNum = toSafeInt(m[1], 0);
    minuteNum = m[2] ? toSafeInt(m[2], 0) : 0;
  }

  if (minuteNum === 60) {
    hourNum += 1;
    minuteNum = 0;
  }

  return {
    hourNum,
    minuteNum,
  };
}

export function getBillablePersons(persons) {
  const n = Number(persons);
  if (!Number.isFinite(n)) return MIN_BILLABLE_PERSONS;
  return Math.max(n, MIN_BILLABLE_PERSONS);
}

export function isWeekend(dateObj) {
  const day = getParisWeekday(dateObj);
  return day === 0 || day === 6;
}

export function isFriday(dateObj) {
  return getParisWeekday(dateObj) === 5;
}

export function getPerPersonRateForDate(dateObj) {
  const hour = getParisDateParts(dateObj).hour;
  const isFridayDate = isFriday(dateObj);
  const isWeekendDate = isWeekend(dateObj);

  if (isFridayDate || isWeekendDate) {
    if (hour >= WEEKEND_AFTERNOON_SWITCH_HOUR || hour < WEEKDAY_END_NIGHT_HOUR) {
      return WEEKEND_AFTER_15_RATE;
    }
    return WEEKEND_BEFORE_15_RATE;
  }

  if (hour >= WEEKDAY_MORNING_START_HOUR && hour < WEEKDAY_MIDDAY_START_HOUR) {
    return WEEKDAY_MORNING_RATE;
  }

  if (hour >= WEEKDAY_MIDDAY_START_HOUR && hour < WEEKDAY_EVENING_START_HOUR) {
    return WEEKDAY_MIDDAY_RATE;
  }

  if (hour >= WEEKDAY_EVENING_START_HOUR || hour < WEEKDAY_END_NIGHT_HOUR) {
    return WEEKDAY_EVENING_RATE;
  }

  return WEEKDAY_MORNING_RATE;
}

export function generateStandardSlotStarts() {
  const slots = [];
  for (let mins = 0; mins <= 22 * 60 + 30; mins += SLOT_DURATION_MINUTES) {
    const hour = Math.floor(mins / 60);
    const minute = mins % 60;
    slots.push(hour + minute / 60);
  }
  return slots;
}

export const STANDARD_SLOT_STARTS = generateStandardSlotStarts();

export function buildTimesFromSlot(slot) {
  if (slot?.start_time && slot?.end_time) {
    const startDate = new Date(slot.start_time);
    const endDate = new Date(slot.end_time);

    if (Number.isNaN(startDate.getTime()) || Number.isNaN(endDate.getTime())) {
      throw new Error("Slot invalide : start_time / end_time invalides");
    }

    return {
      start_time: formatIsoInParis(startDate),
      end_time: formatIsoInParis(endDate),
      date: slot.date || formatDateOnlyInParis(startDate),
      datetime: formatIsoInParis(startDate),
    };
  }

  const date = slot?.date;
  const rawHour = slot?.hour;

  if (!date || rawHour === undefined || rawHour === null) {
    throw new Error("Slot incomplet : date / hour ou start_time / end_time manquants");
  }

  const { hourNum, minuteNum } = parseHourValue(rawHour);

  const startDate = buildUtcDateFromParisLocal(date, hourNum, minuteNum);
  const endDate = new Date(startDate.getTime() + SLOT_DURATION_MINUTES * 60 * 1000);

  return {
    start_time: formatIsoInParis(startDate),
    end_time: formatIsoInParis(endDate),
    date: formatDateOnlyInParis(startDate),
    datetime: formatIsoInParis(startDate),
  };
}

export function buildSlotIsoRange(dateStr, slotHourFloat) {
  const { hourNum, minuteNum } = parseHourValue(slotHourFloat);

  const startDate = buildUtcDateFromParisLocal(dateStr, hourNum, minuteNum);
  const endDate = new Date(startDate.getTime() + SLOT_DURATION_MINUTES * 60 * 1000);

  return {
    startIso: formatIsoInParis(startDate),
    endIso: formatIsoInParis(endDate),
  };
}

export function computeSessionCashAmount(startDate, persons, options = {}) {
  const billablePersons = getBillablePersons(persons);
  const perPersonRate = getPerPersonRateForDate(startDate);
  const singcoinsUsed = !!options.singcoinsUsed;

  if (!singcoinsUsed) {
    return Number((billablePersons * perPersonRate).toFixed(2));
  }

  const extraBillablePersons = Math.max(
    0,
    billablePersons - SINGCOINS_FREE_BILLABLE_PERSONS
  );

  return Number((extraBillablePersons * perPersonRate).toFixed(2));
}

export function computeCartPricing(panier, options = {}) {
  const singcoinsUsed = !!options.singcoinsUsed;
  const safePanier = Array.isArray(panier) ? panier : [];

  const normalizedItems = safePanier.map((slot) => {
    const times = buildTimesFromSlot(slot);
    const startDate = new Date(times.start_time);
    const rawBox = slot.boxId ?? slot.box_id ?? slot.box ?? slot.boxName ?? 1;
    const numericBoxId = getNumericBoxId(rawBox);
    const persons = clampPersons(
      slot.persons || slot.nb_personnes || slot.participants || 2
    );

    const billablePersons = getBillablePersons(persons);

    const theoreticalFullAmount = computeSessionCashAmount(startDate, persons, {
      singcoinsUsed: false,
    });

    const cashAmountDue = computeSessionCashAmount(startDate, persons, {
      singcoinsUsed,
    });

    const singcoinsDiscountAmount = Number(
      (theoreticalFullAmount - cashAmountDue).toFixed(2)
    );

    return {
      ...slot,
      box_id: numericBoxId,
      persons,
      billablePersons,
      start_time: times.start_time,
      end_time: times.end_time,
      date: times.date,
      datetime: times.datetime,
      theoreticalFullAmount,
      cashAmountDue,
      singcoinsDiscountAmount,
    };
  });

  const totalBeforeDiscount = normalizedItems.reduce(
    (sum, item) => sum + item.theoreticalFullAmount,
    0
  );

  const singcoinsDiscount = normalizedItems.reduce(
    (sum, item) => sum + item.singcoinsDiscountAmount,
    0
  );

  const totalCashDue = normalizedItems.reduce(
    (sum, item) => sum + item.cashAmountDue,
    0
  );

  return {
    normalizedItems,
    totalBeforeDiscount: Number(totalBeforeDiscount.toFixed(2)),
    singcoinsDiscount: Number(singcoinsDiscount.toFixed(2)),
    totalCashDue: Number(totalCashDue.toFixed(2)),
  };
}

export function computeModificationDelta({
  reservation,
  targetStart,
  targetPersons,
}) {
  const currentAmount = Number(reservation?.montant || 0);
  const singcoinsUsed = isReservationPaidWithSingcoins(reservation);

  const newAmount = computeSessionCashAmount(targetStart, targetPersons, {
    singcoinsUsed,
  });

  const deltaAmount = Number((newAmount - currentAmount).toFixed(2));

  return {
    oldAmount: currentAmount,
    newAmount,
    deltaAmount,
  };
}
