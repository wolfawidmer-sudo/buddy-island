// Modellauswahl: neueste verfügbare Version, abgelehnte Modelle werden übersprungen.
const assert = require('assert');
const models = require('../src/models');
const learned = require('../src/llm/learned');
const { annotate } = require('../src/llm/index');
const { ProviderError } = require('../src/llm/errors');

learned.clear();
// Google listet alte Versionen weiter, bietet sie neuen Konten aber nicht mehr an
const list = ['gemini-2.5-flash', 'gemini-2.5-flash-lite', 'gemini-2.5-pro', 'gemini-3.5-flash-lite', 'gemini-3.6-flash', 'gemini-3.8-flash',
  'gemini-3.8-flash-preview-09-2026', 'gemini-3.8-flash-image', 'gemini-3.8-flash-live', 'gemini-3.5-pro-preview', 'gemini-embedding-001', 'gemini-4-argon'];
assert.deepStrictEqual(models.resolveTiers(list, 'gemini'), { haiku: 'gemini-3.5-flash-lite', sonnet: 'gemini-3.8-flash', opus: 'gemini-3.5-pro-preview' });
// Offizielles Alias geht vor
assert.strictEqual(models.resolveTiers([...list, 'models/gemini-flash-latest'], 'gemini').sonnet, 'gemini-flash-latest');
// Ohne Liste: Aliase statt fester Versionsnummern
assert.deepStrictEqual(models.resolveTiers([], 'gemini'), { haiku: 'gemini-flash-lite-latest', sonnet: 'gemini-flash-latest', opus: 'gemini-pro-latest' });

// 404 «no longer available»: Modell merken, Nachfolger aus der Meldung übernehmen
const raw = 'This model models/gemini-3.8-flash is no longer available to new users. Please update your code to use models/gemini-3.9-flash for the latest features and improvements.';
const err = new ProviderError(404, raw, 'NOT_FOUND', 'Gemini', { providerId: 'gemini' });
assert.strictEqual(err.category, 'model');
annotate(err, models.PROVIDERS.gemini, 'gemini-3.8-flash');
assert.strictEqual(learned.get('gemini', 'gemini-3.8-flash', 'unavailable'), true);
assert.strictEqual(learned.get('gemini', 'gemini-3.8-flash', 'replacement'), 'gemini-3.9-flash');
assert.strictEqual(models.resolveTiers(list, 'gemini').sonnet, 'gemini-3.8-flash-preview-09-2026', 'abgelehntes Modell wird übersprungen');
// Katalog-Alias abgelehnt: Nachfolger aus der Meldung nehmen
annotate(new ProviderError(404, 'Model gemini-flash-latest not found. Please use models/gemini-3.9-flash instead.', 'NOT_FOUND', 'Gemini', {}), models.PROVIDERS.gemini, 'gemini-flash-latest');
assert.strictEqual(models.resolveTiers([], 'gemini').sonnet, 'gemini-3.9-flash');
// Andere Fehler (z. B. Kontingent) markieren nichts
annotate(new ProviderError(429, 'Quota exceeded', 'RESOURCE_EXHAUSTED', 'Gemini', {}), models.PROVIDERS.gemini, 'gemini-3.5-flash-lite');
assert.strictEqual(learned.get('gemini', 'gemini-3.5-flash-lite', 'unavailable'), undefined);
learned.clear();
console.log('Modell-Tests ok');
