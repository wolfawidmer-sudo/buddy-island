// @ts-check
// Ab 0.13 läuft Buddy nur noch über Buddy Cloud. Diese Funktion bringt gespeicherte
// Einstellungen beim Start auf diesen Stand: alte Keys weg, Anbieter Buddy Cloud,
// einmaliger Hinweis für bestehende Nutzer. Ohne Electron, damit sie testbar ist.

/** Geheimnisse aus der Zeit mit eigenen Keys und lokaler KI (Feldname ohne Encrypted/Plain) */
const LEGACY_SECRETS = ['key', 'key_anthropic', 'key_openai', 'key_xai', 'key_gemini', 'anthropicAdmin', 'openaiAdmin', 'hfToken', 'hfModel'];

/**
 * @param {Record<string, any>} settings aktuelle Einstellungen (wird verändert)
 * @param {Record<string, any>|null} saved was auf der Platte stand (null = erster Start)
 * @param {{ isCloudModel: (id: string) => boolean, defaultModel: string }} opts
 * @returns {boolean} true, wenn sich etwas geändert hat (dann speichern)
 */
function migrateToCloudOnly(settings, saved, opts) {
  let changed = false;
  const hadOwn = settings.provider !== 'buddy'
    || LEGACY_SECRETS.some((n) => settings[n + 'Encrypted'] || settings[n + 'Plain'])
    || Boolean(settings.localModel);
  // Bestehender Nutzer (Einstellungen da, aber aus der Zeit vor der Einführung): keine Einführung,
  // nur einmal ein Hinweis im Chat
  if (saved && !('onboarded' in saved)) {
    settings.onboarded = true;
    settings.cloudNotice = hadOwn ? 'keys-removed' : 'new-cloud';
    changed = true;
  }
  for (const n of LEGACY_SECRETS) {
    if (settings[n + 'Encrypted'] || settings[n + 'Plain']) {
      settings[n + 'Encrypted'] = null;
      settings[n + 'Plain'] = null;
      changed = true;
    }
  }
  if (settings.keyHint || Object.keys(settings.keyHints || {}).length || Object.keys(settings.keyStatus || {}).length) {
    settings.keyHint = null;
    settings.keyHints = {};
    settings.keyStatus = {};
    changed = true;
  }
  if (settings.workspaceId) { settings.workspaceId = ''; changed = true; }
  if (settings.provider !== 'buddy') { settings.provider = 'buddy'; changed = true; }
  if (!opts.isCloudModel(String(settings.model || ''))) { settings.model = opts.defaultModel; changed = true; }
  if (Array.isArray(settings.fallbackModels) && settings.fallbackModels.some((m) => !opts.isCloudModel(m))) {
    settings.fallbackModels = settings.fallbackModels.filter((m) => opts.isCloudModel(m));
    changed = true;
  }
  if (settings.usageLocal) { settings.usageLocal = false; changed = true; }
  return changed;
}

module.exports = { migrateToCloudOnly, LEGACY_SECRETS };
