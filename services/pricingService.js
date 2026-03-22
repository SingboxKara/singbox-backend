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

import {
  addDaysToDateString,
} from "../utils/dates.js";
import { clampPersons, getNumericBoxId } from "../utils/validators.js";
import { isReservationPaidWithSingcoins } from "./singcoinService.js";

export function getBillablePersons(persons) {
  const n = Number(persons);
  if (!Number.isFinite(n)) return MIN_BILLABLE_PERSONS;
  return Math.max(n, MIN_BILLABLE_PERSONS);
}

export function isWeekend(dateObj) {
  const day = dateObj.getDay();
  return day === 0 || day === 6;
}

export function isFriday(dateObj) {
  return dateObj.getDay() === 5;
}

export function getPerPersonRateForDate(dateObj) {
  const hour = dateObj.getHours();
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
  if (slot.start_time && slot.end_time) {
    const dateFromStart = slot.date || String(slot.start_time).slice(0, 10);
    return {
      start_time: slot.start_time,
      end_time: slot.end_time,
      date: dateFromStart,
      datetime: slot.start_time,
    };
  }

  const date = slot.date;
  const rawHour = slot.hour;

  if (!date || rawHour === undefined || rawHour === null) {
    throw new Error("Slot incomplet : date / hour ou start_time / end_time manquants");
  }

  let hourNum = 0;
  let minuteNum = 0;

  if (typeof rawHour === "number") {
    hourNum = Math.floor(rawHour);
    minuteNum = Math.round((rawHour - hourNum) * 60);
  } else {
    const m = String(rawHour).match(/(\d{1,2})[h:]?(\d{2})?/);
    if (m) {
      hourNum = parseInt(m[1], 10);
      minuteNum = m[2] ? parseInt(m[2], 10) : 0;
    }
  }

  const OFFSET = "+01:00";

  const startHourStr = String(hourNum).padStart(2, "0");
  const startMinStr = String(minuteNum).padStart(2, "0");
  const startIso = `${date}T${startHourStr}:${startMinStr}:00${OFFSET}`;

  const totalStartMinutes = hourNum * 60 + minuteNum + SLOT_DURATION_MINUTES;
  const minutesPerDay = 24 * 60;

  const endDayOffset = Math.floor(totalStartMinutes / minutesPerDay);
  const minutesOfDay = totalStartMinutes % minutesPerDay;

  const endHour = Math.floor(minutesOfDay / 60);
  const endMinute = minutesOfDay % 60;

  const endDateStr =
    endDayOffset === 0 ? date : addDaysToDateString(date, endDayOffset);

  const endHourStr = String(endHour).padStart(2, "0");
  const endMinStr = String(endMinute).padStart(2, "0");
  const endIso = `${endDateStr}T${endHourStr}:${endMinStr}:00${OFFSET}`;

  return {
    start_time: startIso,
    end_time: endIso,
    date,
    datetime: startIso,
  };
}

export function buildSlotIsoRange(dateStr, slotHourFloat) {
  const hourNum = Math.floor(slotHourFloat);
  const minuteNum = Math.round((slotHourFloat - hourNum) * 60);

  const OFFSET = "+01:00";
  const hh = String(hourNum).padStart(2, "0");
  const mm = String(minuteNum).padStart(2, "0");

  const startIso = `${dateStr}T${hh}:${mm}:00${OFFSET}`;
  const startDate = new Date(startIso);
  const endDate = new Date(startDate.getTime() + SLOT_DURATION_MINUTES * 60 * 1000);

  const endY = endDate.getFullYear();
  const endM = String(endDate.getMonth() + 1).padStart(2, "0");
  const endD = String(endDate.getDate()).padStart(2, "0");
  const endH = String(endDate.getHours()).padStart(2, "0");
  const endMin = String(endDate.getMinutes()).padStart(2, "0");

  const endIso = `${endY}-${endM}-${endD}T${endH}:${endMin}:00${OFFSET}`;

  return { startIso, endIso };
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

  const normalizedItems = panier.map((slot) => {
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