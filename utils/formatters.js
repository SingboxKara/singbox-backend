// backend/utils/formatters.js

export function roundMoney(value) {
  return Number(Number(value || 0).toFixed(2));
}