// @ts-check
// Adresse des Buddy-Cloud-Backends.
// Fest in package.json («buddyCloud.apiUrl»), für Entwicklung per BUDDY_CLOUD_URL überschreibbar.
// Erlaubt sind nur https:// (Produktiv) und http://127.0.0.1 / localhost (Entwicklung).
// Ist keine Adresse gesetzt, bleibt Buddy Cloud aus – lokale KI und eigene Keys laufen normal.

const pkg = require('../../package.json');

/** @param {unknown} raw */
function clean(raw) {
  const v = String(raw || '').trim().replace(/\/+$/, '');
  if (!v) return '';
  if (/^https:\/\/[a-z0-9.-]+(:\d+)?(\/[\w./-]*)?$/i.test(v)) return v;
  if (/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?(\/[\w./-]*)?$/i.test(v)) return v;
  return '';
}

function apiUrl() {
  return clean(process.env.BUDDY_CLOUD_URL) || clean(/** @type {any} */ (pkg).buddyCloud?.apiUrl);
}

module.exports = { apiUrl, clean };
