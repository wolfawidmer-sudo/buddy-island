'use strict';
// Startguthaben für neue Konten: einmal pro Konto, pro E-Mail-Adresse und pro PC.
// Die App schickt eine PC-Kennung (SHA-256 der Windows-MachineGuid, nie die Kennung selbst).
// Hier werden E-Mail, PC-Kennung und IP nochmals mit einem geheimen Schlüssel gehasht (HMAC),
// damit in der Datenbank nichts Lesbares steht. Ganz verhindern lassen sich Mehrfachkonten nicht
// (anderer PC, neu installiertes Windows, virtuelle Maschinen) – es wird nur mühsam.

const crypto = require('node:crypto');
const { badRequest } = require('../lib/errors');

// E-Mail vergleichbar machen: klein, ohne «+zusatz»; bei Gmail ohne Punkte (a.b@gmail.com = ab@gmail.com)
function normalizeEmail(email) {
  const e = String(email || '').trim().toLowerCase();
  const at = e.lastIndexOf('@');
  if (at < 1) return e;
  let local = e.slice(0, at);
  let domain = e.slice(at + 1);
  local = local.split('+')[0];
  if (domain === 'googlemail.com') domain = 'gmail.com';
  if (domain === 'gmail.com') local = local.replace(/\./g, '');
  return `${local}@${domain}`;
}

/** @param {{ supabase: any, config: any, logger: any }} deps */
function createWelcomeService({ supabase, config, logger }) {
  const amount = Number(config.welcome?.credits || 0);
  const key = config.welcome?.hashSecret
    || crypto.createHash('sha256').update(`buddy-welcome:${config.supabase.secretKey || ''}`).digest('hex');
  const mac = (kind, v) => crypto.createHmac('sha256', key).update(`${kind}:${v}`).digest('hex');

  /** @param {{ id: string, email?: string }} user @param {string} deviceId @param {string} [ip] */
  async function claim(user, deviceId, ip) {
    if (!(amount > 0)) return { granted: false, reason: 'disabled', amount: '0' };
    if (!user.email) throw badRequest('Für das Startguthaben braucht das Konto eine E-Mail-Adresse.');
    const r = await supabase.rpc('grant_welcome_credits', {
      p_user_id: user.id,
      p_email_hash: mac('email', normalizeEmail(user.email)),
      p_device_hash: mac('device', String(deviceId).toLowerCase()),
      p_ip_hash: ip ? mac('ip', ip) : null,
      p_amount: String(amount),
      p_ip_daily_limit: Number(config.welcome?.ipDailyLimit || 3),
    });
    const out = { granted: Boolean(r?.granted), reason: String(r?.reason || 'unknown'), amount: r?.granted ? String(amount) : '0' };
    logger.info('welcome_credits', { granted: out.granted, reason: out.reason });
    return out;
  }

  return { claim, amount: () => amount };
}

module.exports = { createWelcomeService, normalizeEmail };
