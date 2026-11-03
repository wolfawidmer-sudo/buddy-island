// Berechtigungssystem: jede Aktion bekommt eine Risikostufe.
//   niedrig  – lesen, Programme öffnen, Bildschirmfotos
//   mittel   – Dateien verschieben, Einstellungen in Apps ändern, Software installieren, PC steuern
//   hoch     – Dateien löschen, Admin-Befehle, System- und Sicherheitseinstellungen
// Hoch braucht immer eine ausdrückliche Zustimmung (oder ist ganz gesperrt).
// Buddy selbst läuft ohne Administratorrechte und hat keinen freien Befehlszeilen-Zugang.

const { t } = require('./i18n');

const LEVELS = ['low', 'medium', 'high'];
const LEVEL_LABEL = { low: 'Niedrig', medium: 'Mittel', high: 'Hoch' };

const CATEGORY_LABEL = {
  read: 'Informationen lesen',
  open: 'Programm oder Seite öffnen',
  screen: 'Bildschirm ansehen',
  control: 'PC mit Maus und Tastatur steuern',
  files: 'Dateien verschieben oder anlegen',
  settings: 'Einstellungen in einer App ändern',
  install: 'Software installieren',
  delete: 'Dateien löschen',
  admin: 'Befehl mit Administratorrechten',
  system: 'Systemeinstellungen ändern',
  security: 'Sicherheitseinstellungen ändern',
  send: 'Etwas in deinem Namen senden',
};

// Muster in getipptem Text, die auf riskante Befehle hinweisen.
// Reihenfolge = Priorität (Sicherheit vor Admin vor Löschen …).
const TEXT_RULES = [
  {
    level: 'high',
    category: 'security',
    test: /(set-mppreference|add-mppreference|disablerealtimemonitoring|disableioavprotection|windowsdefender:|\bmpcmdrun\b|netsh\s+(adv)?firewall|set-netfirewallprofile|disable-netfirewall|enablelua|consentpromptbehavior|smartscreen|manage-bde|disable-bitlocker|tamperprotection|exclusionpath)/i,
  },
  {
    level: 'high',
    category: 'admin',
    test: /(\brunas\b|-verb\s+runas|\bsudo\b|\bbcdedit\b|\bsfc\s+\/|\bdism\b|\btakeown\b|\bicacls\b|\bnet\s+(user|localgroup)\b|\breg(\.exe)?\s+(add|delete|import|load)\b|\bregedit\b|\bhklm:?\\|hkey_local_machine|\bschtasks\b.*\/create|\bsc(\.exe)?\s+(create|delete|config|stop)\b|\b(stop|set)-service\b|\bvssadmin\b|\bwmic\b|set-executionpolicy|\bgpedit\b|\bsecpol\b|\bdiskpart\b|\bformat(-volume)?\s+[a-z]:)/i,
  },
  {
    level: 'high',
    category: 'delete',
    test: /(\bremove-item\b|\brm\s+-\w*[rf]|\brmdir\b|\brd\s+\/s|\bdel(\.exe)?\s+(\/[a-z]\s+)*["']?[a-z]:|\bdel\s+\/[fqs]|\berase\s|\bclear-recyclebin\b|\bcipher\s+\/w|\bshred\b)/i,
  },
  {
    level: 'high',
    category: 'system',
    test: /(ms-settings:(windowsupdate|recovery|activation|developers|backup)|\bpowercfg\b|\bsystemreset\b|\brstrui\b|\bshutdown\s+[\/-][srfp]|\bwinget\s+(uninstall|remove)\b|\buninstall-(package|module)\b|\bappwiz\.cpl\b|\bmsconfig\b)/i,
  },
  {
    level: 'medium',
    category: 'install',
    test: /(\bwinget\s+(install|upgrade)\b|\bchoco\s+install\b|\bscoop\s+install\b|\bmsiexec\b|\binstall-(package|module)\b|\bnpm\s+(i|install)\s+-g\b|\bpip3?\s+install\b)/i,
  },
];

// Tastenkürzel mit Risiko
const KEY_RULES = [
  { level: 'high', category: 'delete', test: /^(shift\+(delete|del)|(delete|del)\+shift)$/i },
  { level: 'high', category: 'admin', test: /^ctrl\+shift\+(return|enter)$/i },
];

const COMPUTER_LOW = new Set(['screenshot', 'zoom', 'cursor_position', 'wait', 'mouse_move', 'scroll']);

const TOOL_RISK = {
  // Lesen
  list_timers: ['low', 'read'],
  now_playing: ['low', 'read'],
  calendar_events: ['low', 'read'],
  recent_notifications: ['low', 'read'],
  list_files: ['low', 'read'],
  find_duplicates: ['low', 'read'],
  system_info: ['low', 'read'],
  ai_usage: ['low', 'read'],
  update_plan: ['low', 'read'],
  escalate: ['low', 'read'],
  // Öffnen und Harmloses
  set_timer: ['low', 'open'],
  cancel_timer: ['low', 'open'],
  open_website: ['low', 'open'],
  open_app: ['low', 'open'],
  open_settings: ['low', 'open'],
  media_control: ['low', 'open'],
  // Dateien
  create_folder: ['medium', 'files'],
  move_files: ['medium', 'files'],
  delete_files: ['high', 'delete'],
};

function scanText(text) {
  const q = String(text || '');
  for (const rule of TEXT_RULES) if (rule.test.test(q)) return rule;
  return null;
}

function normCombo(text) {
  return String(text || '').toLowerCase().replace(/\s+/g, '').replace(/control/g, 'ctrl');
}

// call: { name, input, toolset_name }
function classify(call) {
  const name = call?.name;
  const input = call?.input || {};

  if (call?.toolset_name === 'computer') {
    if (COMPUTER_LOW.has(name)) return result('low', 'screen');
    if (name === 'type') {
      const rule = scanText(input.text);
      if (rule) return result(rule.level, rule.category, t('Tippt: «{text}»', { text: String(input.text).trim().slice(0, 120) }));
    }
    if (name === 'key' || name === 'hold_key') {
      const combo = normCombo(input.text);
      const rule = KEY_RULES.find((r) => r.test.test(combo));
      if (rule) return result(rule.level, rule.category, t('Drückt {keys}', { keys: input.text }));
    }
    return result('medium', 'control');
  }

  if (name === 'request_permission') {
    const level = input.risk === 'high' ? 'high' : 'medium';
    const category = CATEGORY_LABEL[input.category] ? input.category : level === 'high' ? 'system' : 'settings';
    return result(level, category, String(input.action || '').slice(0, 200), String(input.details || '').slice(0, 400));
  }

  const known = TOOL_RISK[name];
  if (known) return result(known[0], known[1]);
  // Unbekanntes lieber vorsichtig behandeln
  return result('medium', 'settings');
}

function result(level, category, summary = '', details = '') {
  return { level, category, label: CATEGORY_LABEL[category] ? t(CATEGORY_LABEL[category]) : category, levelLabel: t(LEVEL_LABEL[level]), summary, details };
}

// Entscheidet anhand der Einstellungen und der für diese Aufgabe erteilten Freigaben.
// policy: { medium: 'ask' | 'allow', high: 'ask' | 'block' }
// grants: { control: bool|null, medium: bool }
// Rückgabe: 'allow' | 'ask' | 'ask-control' | 'deny'
function decide(risk, policy = {}, grants = {}) {
  if (risk.level === 'low') return 'allow';
  if (risk.level === 'medium') {
    if (risk.category === 'control') {
      if (grants.control === true) return 'allow';
      if (grants.control === false) return 'deny';
      return 'ask-control';
    }
    if (policy.medium === 'allow' || grants.medium) return 'allow';
    return 'ask';
  }
  // Hohes Risiko: nie automatisch
  if (policy.high === 'block') return 'deny';
  return 'ask';
}

function cleanPolicy(p = {}) {
  return {
    medium: p.medium === 'allow' ? 'allow' : 'ask',
    high: p.high === 'block' ? 'block' : 'ask',
  };
}

module.exports = { classify, decide, scanText, cleanPolicy, LEVELS, LEVEL_LABEL, CATEGORY_LABEL };
