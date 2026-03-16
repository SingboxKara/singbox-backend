// backend/utils/dates.js

export function isDateInRange(isoDate, start, end) {
  return isoDate >= start && isoDate <= end;
}

export function parseDateOrNull(value) {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

export function formatDateToYYYYMMDD(dateObj) {
  const y = dateObj.getFullYear();
  const m = String(dateObj.getMonth() + 1).padStart(2, "0");
  const d = String(dateObj.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

export function addDaysToDateString(dateStr, daysToAdd) {
  const [y, m, d] = dateStr.split("-").map((x) => parseInt(x, 10));
  const base = new Date(Date.UTC(y, m - 1, d));
  base.setUTCDate(base.getUTCDate() + daysToAdd);
  const ny = base.getUTCFullYear();
  const nm = String(base.getUTCMonth() + 1).padStart(2, "0");
  const nd = String(base.getUTCDate()).padStart(2, "0");
  return `${ny}-${nm}-${nd}`;
}

export function hoursBeforeDate(isoValue) {
  const d = parseDateOrNull(isoValue);
  if (!d) return null;
  return (d.getTime() - Date.now()) / (1000 * 60 * 60);
}

export function areTimeRangesOverlapping(startA, endA, startB, endB) {
  const aStart = parseDateOrNull(startA);
  const aEnd = parseDateOrNull(endA);
  const bStart = parseDateOrNull(startB);
  const bEnd = parseDateOrNull(endB);

  if (!aStart || !aEnd || !bStart || !bEnd) return false;

  return aStart.getTime() < bEnd.getTime() && aEnd.getTime() > bStart.getTime();
}