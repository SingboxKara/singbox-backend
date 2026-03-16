// backend/constants/booking.js

export const PRICE_PER_SLOT_EUR = 10;
export const DEPOSIT_AMOUNT_EUR = 250;
export const SLOT_DURATION_MINUTES = 90;
export const MODIFICATION_DEADLINE_HOURS = 6;

export const MIN_ALLOWED_PERSONS = 1;
export const MAX_ALLOWED_PERSONS = 8;
export const MIN_BILLABLE_PERSONS = 2;

export const LOYALTY_POINTS_COST = 100;
export const LOYALTY_FREE_BILLABLE_PERSONS = 2;

export const OFF_PEAK_START_HOUR = 4;
export const OFF_PEAK_END_HOUR = 14;
export const OFF_PEAK_RATE = 7.9;
export const STANDARD_RATE = 9.9;

export const CONFIRMED_STATUSES = [
  "confirmed",
  "confirmé",
  "confirmée",
  "confirme",
  "confirmee",
];

export const CANCELLED_OR_REFUNDED_STATUSES = [
  "cancelled",
  "canceled",
  "annulé",
  "annule",
  "annulée",
  "annulee",
  "refunded",
  "refund",
  "remboursé",
  "rembourse",
  "remboursée",
  "remboursee",
];