// backend/utils/validators.js

import {
  MIN_ALLOWED_PERSONS,
  MAX_ALLOWED_PERSONS,
} from "../constants/booking.js";

export function safeText(v, max = 255) {
  if (v === undefined || v === null) return null;
  const s = String(v).trim();
  if (!s) return null;
  return s.length > max ? s.slice(0, max) : s;
}

export function safeCountry(v) {
  const s = String(v || "").trim();
  if (!s) return null;
  return s.length > 10 ? s.slice(0, 10) : s;
}

export function safeBirthdate(v) {
  if (!v) return null;
  const s = String(v).slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  return s;
}

export function getNumericBoxId(rawBox) {
  let numericBoxId = parseInt(String(rawBox).replace(/[^0-9]/g, ""), 10);
  if (!Number.isFinite(numericBoxId)) numericBoxId = 1;
  return numericBoxId;
}

export function clampPersons(value) {
  let n = Number.parseInt(value, 10);
  if (Number.isNaN(n) || n < MIN_ALLOWED_PERSONS) n = MIN_ALLOWED_PERSONS;
  if (n > MAX_ALLOWED_PERSONS) n = MAX_ALLOWED_PERSONS;
  return n;
}