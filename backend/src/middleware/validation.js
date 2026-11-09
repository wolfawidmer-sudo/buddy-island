'use strict';
// Kleine Schema-Prüfung für Anfragen. Unbekannte Felder werden abgelehnt (strict),
// damit niemand zusätzliche Felder (z. B. user_id) einschleusen kann.

const { badRequest } = require('../lib/errors');

const EMAIL = /^[^\s@]{1,64}@[^\s@]{1,255}\.[^\s@]{2,63}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Regeln: { type: 'string'|'number'|'integer'|'boolean'|'object'|'array'|'any', required?, min?, max?, pattern?, enum?, email?, uuid? }
 * @param {Record<string, any>} schema @param {any} value @param {{ strict?: boolean }} [opts]
 */
function check(schema, value, { strict = true } = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw badRequest('Anfrage muss ein JSON-Objekt sein');
  if (strict) {
    const extra = Object.keys(value).filter((k) => !(k in schema));
    if (extra.length) throw badRequest(`Unbekannte Felder: ${extra.slice(0, 5).join(', ')}`);
  }
  /** @type {Record<string, any>} */
  const out = {};
  for (const [key, rule] of Object.entries(schema)) {
    const v = value[key];
    if (v === undefined || v === null) {
      if (rule.required) throw badRequest(`Feld fehlt: ${key}`);
      continue;
    }
    const fail = (why) => { throw badRequest(`Feld ${key}: ${why}`); };
    switch (rule.type) {
      case 'string':
        if (typeof v !== 'string') fail('Text erwartet');
        if (rule.min !== undefined && v.length < rule.min) fail(`mindestens ${rule.min} Zeichen`);
        if (rule.max !== undefined && v.length > rule.max) fail(`höchstens ${rule.max} Zeichen`);
        if (rule.email && !EMAIL.test(v)) fail('keine gültige E-Mail-Adresse');
        if (rule.uuid && !UUID.test(v)) fail('keine gültige ID');
        if (rule.pattern && !rule.pattern.test(v)) fail('ungültiges Format');
        if (rule.enum && !rule.enum.includes(v)) fail('ungültiger Wert');
        break;
      case 'integer':
        if (!Number.isInteger(v)) fail('ganze Zahl erwartet');
        if (rule.min !== undefined && v < rule.min) fail(`mindestens ${rule.min}`);
        if (rule.max !== undefined && v > rule.max) fail(`höchstens ${rule.max}`);
        break;
      case 'boolean':
        if (typeof v !== 'boolean') fail('true/false erwartet');
        break;
      case 'object':
        if (typeof v !== 'object' || Array.isArray(v)) fail('Objekt erwartet');
        break;
      case 'array':
        if (!Array.isArray(v)) fail('Liste erwartet');
        if (rule.max !== undefined && v.length > rule.max) fail(`höchstens ${rule.max} Einträge`);
        break;
      case 'string|array':
        if (typeof v !== 'string' && !Array.isArray(v)) fail('Text oder Liste erwartet');
        break;
      default:
        break;
    }
    out[key] = typeof v === 'string' && rule.trim !== false ? v.trim() : v;
  }
  return out;
}

/** Middleware: prüft req.body und ersetzt es durch die geprüfte Fassung. */
const body = (schema, opts) => (req) => { req.body = check(schema, req.body || {}, opts); };

/** limit-Parameter aus der Query (1..max, Standard def) */
function limitParam(req, def = 50, max = 200) {
  const n = Number.parseInt(req.query.get('limit') || '', 10);
  return Number.isFinite(n) ? Math.min(Math.max(n, 1), max) : def;
}

module.exports = { check, body, limitParam, EMAIL, UUID };
