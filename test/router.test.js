// Tests für den Modell-Router (Regeln, Dispatcher, Budget, manuelle Wahl)
const assert = require('assert');
const { createRouter, tierForStep, policy } = require('../src/router');
const { createUsage } = require('../src/usage');

const tiers = { haiku: 'claude-haiku-5-5', sonnet: 'claude-sonnet-5-5', opus: 'claude-opus-5-5' };

function fakeClaude(answer, { fail = false } = {}) {
  const calls = [];
  return {
    calls,
    json: async (req) => {
      calls.push(req);
      if (fail) throw Object.assign(new Error('offline'), { status: 0 });
      return { data: answer, usage: { input_tokens: 600, output_tokens: 80 } };
    },
  };
}

const analysis = (over = {}) => ({
  komplexitaet: 'mittel', reasoning: 'mittel', schritte: 4, faehigkeiten: ['dateien', 'planung'], risiko: 'mittel',
  risiken: ['Dateien verschieben'], tokens: 600, modell: 'sonnet', aufwand: 'medium', begruendung: 'Mehrstufige Dateiorganisation', ...over,
});

(async () => {
  const usage = createUsage({});
  const auto = { autoModel: true, effort: 'auto' };

  // Einfache Anfragen: Regel, kein API-Aufruf
  let claude = fakeClaude(analysis());
  let router = createRouter({ claude, usage });
  for (const text of ['Hoi', 'Stell einen Timer auf 10 Minuten', 'Öffne den Rechner', 'Pausier die Musik', 'Wie spät ist es?', 'Was steht heute an?']) {
    const d = await router.route({ text, tiers, settings: auto });
    assert.strictEqual(d.source, 'regel', text);
    assert.strictEqual(d.tier, 'haiku', text);
    assert.strictEqual(d.effort, 'low', text);
  }
  assert.strictEqual(claude.calls.length, 0, 'keine Router-Kosten für Einfaches');

  // Mehrstufig: Haiku als Dispatcher, strukturierte Ausgabe, Ergebnis Sonnet
  const text = 'Suche alle doppelten Dateien auf meinem Desktop, sortiere die übrigen Dateien in passende Ordner und erstelle eine Zusammenfassung.';
  let d = await router.route({ text, tiers, settings: auto, withComputer: true });
  assert.strictEqual(claude.calls.length, 1);
  assert.strictEqual(claude.calls[0].model, 'claude-haiku-5-5', 'Haiku ist der Dispatcher');
  assert.ok(claude.calls[0].schema && claude.calls[0].schema.additionalProperties === false, 'JSON-Schema');
  assert.strictEqual(d.source, 'haiku');
  assert.strictEqual(d.tier, 'sonnet');
  assert.strictEqual(d.model, 'claude-sonnet-5-5');
  assert.strictEqual(d.effort, 'medium');
  assert.strictEqual(d.needsPlan, true);
  assert.ok(d.estimate > 0 && d.routerCost > 0);
  assert.strictEqual(usage.summary(0).totals.requests, 1, 'Router-Kosten verbucht');
  // Gleiche Anfrage nochmals: aus dem Zwischenspeicher
  d = await router.route({ text, tiers, settings: auto });
  assert.strictEqual(d.source, 'cache');
  assert.strictEqual(claude.calls.length, 1);

  // Günstigstes geeignetes Modell: «einfach» wird Haiku, auch wenn Sonnet vorgeschlagen wird
  claude = fakeClaude(analysis({ komplexitaet: 'einfach', faehigkeiten: ['wissen'], schritte: 1, modell: 'sonnet', aufwand: 'medium' }));
  router = createRouter({ claude, usage });
  d = await router.route({ text: 'Erklär mir kurz, was eine Primzahl ist, bitte schön', tiers, settings: auto });
  assert.strictEqual(d.tier, 'haiku');
  assert.strictEqual(d.effort, 'low');

  // Programmieren braucht mindestens Sonnet
  assert.strictEqual(policy(analysis({ komplexitaet: 'einfach', faehigkeiten: ['programmieren'], schritte: 1, modell: 'haiku' })).tier, 'sonnet');
  // Opus nur bei wirklich hohem Bedarf
  assert.strictEqual(policy(analysis({ komplexitaet: 'mittel', modell: 'opus' })).tier, 'sonnet');
  assert.strictEqual(policy(analysis({ komplexitaet: 'hoch', reasoning: 'hoch', modell: 'opus' })).tier, 'opus');
  assert.strictEqual(policy(analysis({ komplexitaet: 'sehr_hoch', modell: 'haiku' })).tier, 'opus');

  // Budget: ab 80 % kein Opus, ab 95 % nur Haiku
  claude = fakeClaude(analysis({ komplexitaet: 'sehr_hoch', reasoning: 'hoch', modell: 'opus', aufwand: 'high', faehigkeiten: ['fehlersuche'] }));
  router = createRouter({ claude, usage });
  const hard = 'Mein Node-Server stürzt sporadisch mit einem Speicherleck ab, finde die Ursache im Code';
  d = await router.route({ text: hard, tiers, settings: auto, budget: { level: 'ok' } });
  assert.strictEqual(d.tier, 'opus');
  assert.strictEqual(d.effort, 'high');
  d = await router.route({ text: hard + ' ', tiers, settings: auto, budget: { level: 'warn' } });
  assert.strictEqual(d.tier, 'sonnet');
  assert.match(d.reason, /Budget/);
  d = await router.route({ text: hard + '  !', tiers, settings: auto, budget: { level: 'tight' } });
  assert.strictEqual(d.tier, 'haiku');

  // Opus nicht verfügbar: Sonnet
  d = await router.route({ text: hard + ' bitte', tiers: { haiku: tiers.haiku, sonnet: tiers.sonnet }, settings: auto });
  assert.strictEqual(d.tier, 'sonnet');

  // Manuelle Denktiefe bleibt
  d = await router.route({ text: hard + ' jetzt', tiers, settings: { autoModel: true, effort: 'low' } });
  assert.strictEqual(d.effort, 'low');

  // Manuelle Modellwahl: kein Router-Aufruf
  claude = fakeClaude(analysis());
  router = createRouter({ claude, usage });
  d = await router.route({ text: 'Was auch immer, egal wie schwierig das hier ist', tiers, settings: { autoModel: false, model: 'claude-opus-5-5', effort: 'high' } });
  assert.strictEqual(d.source, 'manuell');
  assert.strictEqual(d.model, 'claude-opus-5-5');
  assert.strictEqual(d.effort, 'high');
  assert.strictEqual(claude.calls.length, 0);

  // Fortsetzung bleibt beim bisherigen Modell
  d = await router.route({ text: 'ja mach weiter', tiers, settings: auto, meta: { lastTier: 'sonnet' } });
  assert.strictEqual(d.tier, 'sonnet');
  assert.strictEqual(claude.calls.length, 0);

  // Dispatcher offline: vorsichtige Standardwahl, kein Absturz
  claude = fakeClaude(null, { fail: true });
  router = createRouter({ claude, usage });
  d = await router.route({ text: 'Organisier meine Downloads nach Dateityp in Unterordner', tiers, settings: auto });
  assert.strictEqual(d.source, 'standard');
  assert.strictEqual(d.tier, 'sonnet');

  // Schritte: einfache Schritte günstig, schwere höchstens bis zur Obergrenze
  const dec = { tier: 'sonnet', allowOpus: false };
  assert.strictEqual(tierForStep('simple', { decision: dec, tiers }), 'haiku');
  assert.strictEqual(tierForStep('normal', { decision: dec, tiers }), 'sonnet');
  assert.strictEqual(tierForStep('hard', { decision: dec, tiers }), 'sonnet', 'Opus nicht ohne Grund');
  assert.strictEqual(tierForStep('hard', { decision: { tier: 'sonnet', allowOpus: true }, tiers }), 'opus');
  assert.strictEqual(tierForStep('hard', { decision: { tier: 'sonnet', allowOpus: true }, tiers, budget: { level: 'warn' } }), 'sonnet');

  console.log('Router-Tests ok');
})().catch((e) => { console.error(e); process.exit(1); });
