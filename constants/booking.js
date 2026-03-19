// backend/constants/booking.js

export const PRICE_PER_SLOT_EUR = 10;
export const DEPOSIT_AMOUNT_EUR = 250;
export const SLOT_DURATION_MINUTES = 90;

export const MODIFICATION_DEADLINE_HOURS = 6;
export const REFUND_DEADLINE_HOURS = 24;

export const MIN_ALLOWED_PERSONS = 1;
export const MAX_ALLOWED_PERSONS = 8;
export const MIN_BILLABLE_PERSONS = 2;

export const LOYALTY_POINTS_COST = 100;
export const LOYALTY_FREE_BILLABLE_PERSONS = 2;

/**
 * Nouvelle grille tarifaire Singbox
 *
 * Règles :
 * - Semaine (lundi à jeudi)
 *   - 08h–12h : 4.99€
 *   - 12h–15h : 9.99€
 *   - 15h–02h : 11.99€
 *
 * - Vendredi
 *   - avant 15h : 12.99€
 *   - à partir de 15h : 14.99€
 *
 * - Samedi / dimanche
 *   - avant 15h : 12.99€
 *   - à partir de 15h : 14.99€
 *
 * Important :
 * - plus aucune majoration "vacances scolaires"
 * - le tarif dépend uniquement du jour + heure de début du créneau
 */
export const WEEKDAY_MORNING_RATE = 4.99;     // 08h00 -> 11h59
export const WEEKDAY_MIDDAY_RATE = 9.99;      // 12h00 -> 14h59
export const WEEKDAY_EVENING_RATE = 11.99;    // 15h00 -> 01h59

export const WEEKEND_BEFORE_15_RATE = 12.99;  // vendredi avant 15h + samedi/dimanche avant 15h
export const WEEKEND_AFTER_15_RATE = 14.99;   // vendredi dès 15h + samedi/dimanche dès 15h

export const WEEKDAY_MORNING_START_HOUR = 8;
export const WEEKDAY_MIDDAY_START_HOUR = 12;
export const WEEKDAY_EVENING_START_HOUR = 15;
export const WEEKDAY_END_NIGHT_HOUR = 2;

export const WEEKEND_AFTERNOON_SWITCH_HOUR = 15;

export const GUEST_MANAGE_TOKEN_BYTES = 32;
export const GUEST_MANAGE_TOKEN_TTL_DAYS = 90;

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