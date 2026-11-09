'use strict';
// Exakte Dezimalzahlen ohne Fliesskomma (BigInt in festen Nachkommastellen).
// Nur für Anzeige-Summen und Umrechnungen von Beträgen; Abrechnung passiert in Postgres.

/** "12.345" → BigInt in 10^-scale Einheiten @param {string|number} v @param {number} scale */
function toUnits(v, scale = 6) {
  const s = String(v ?? '0').trim();
  const m = /^(-)?(\d+)(?:\.(\d+))?$/.exec(s);
  if (!m) throw new Error(`Keine Dezimalzahl: ${s}`);
  const frac = (m[3] || '').padEnd(scale, '0');
  if (frac.length > scale && /[1-9]/.test(frac.slice(scale))) throw new Error(`Zu viele Nachkommastellen: ${s}`);
  const units = BigInt(m[2]) * 10n ** BigInt(scale) + BigInt(frac.slice(0, scale) || '0');
  return m[1] ? -units : units;
}

/** BigInt-Einheiten → "12.345000" */
function fromUnits(units, scale = 6) {
  const neg = units < 0n;
  const a = neg ? -units : units;
  const base = 10n ** BigInt(scale);
  const int = a / base;
  const frac = String(a % base).padStart(scale, '0');
  return `${neg ? '-' : ''}${int}${scale ? `.${frac}` : ''}`;
}

/** Summe exakter Dezimalstrings */
function add(...values) {
  return fromUnits(values.reduce((sum, v) => sum + toUnits(v), 0n));
}

/** "12.34" USD → 1234 Cent (wirft bei mehr als 2 Nachkommastellen) */
function dollarsToCents(v) {
  const c = toUnits(v, 2);
  if (c < 0n || c > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('Ungültiger Betrag');
  return Number(c);
}

/** 1234 → "12.34" */
function centsToDollars(cents) {
  const c = Number(cents);
  if (!Number.isSafeInteger(c) || c < 0) throw new Error('Ungültiger Betrag');
  return fromUnits(BigInt(c), 2);
}

module.exports = { toUnits, fromUnits, add, dollarsToCents, centsToDollars };
