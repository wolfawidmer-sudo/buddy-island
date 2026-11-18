'use strict';
// Regeln für «Befehl ausführen» (PowerShell). Rein, ohne Electron: in test/terminal.test.js geprüft.
//
// - Harte Sperrliste: auch mit Freigabe nie ausführbar (Sicherheitsregel 12).
// - «Immer erlauben» nur für eine feste Liste rein lesender Befehle und nur in einfacher Form
//   (ein Befehl, keine Pipes, Verkettungen, Umleitungen oder Unterausdrücke).
// Die Sperrliste ist eine Bremse gegen Fehler und Prompt-Injection, keine Sandbox: Deshalb läuft
// trotzdem jeder Befehl erst nach Klick im Island, ohne Adminrechte und mit Zeitlimit.

const MAX_COMMAND = 2000;

// Fest: rein lesende Befehle, für die es «Immer erlauben» gibt (Vorgabe Wolf, Lauf 3)
const READ_ONLY = ['get-date', 'get-childitem', 'get-process', 'test-netconnection', 'ipconfig'];
const READ_ONLY_ALIASES = { gci: 'get-childitem', ls: 'get-childitem', dir: 'get-childitem', gps: 'get-process', ps: 'get-process', tnc: 'test-netconnection' };
// Parameter, die bei diesen Befehlen etwas verändern oder fremde Rechner abfragen würden
const READ_ONLY_FORBIDDEN_ARGS = /(^|\s)(\/release|\/renew|\/flushdns|\/registerdns|\/setclassid|-computername|-cimsession|-credential)\b/i;

/** Text für den Vergleich: Backtick-Escapes, Carets (cmd) und Mehrfach-Leerzeichen weg, klein */
function normalize(command) {
  return String(command || '')
    .normalize('NFKC')
    .replace(/`(.)/g, '$1') // PowerShell-Escape: R`emove-Item → Remove-Item
    .replace(/\^(.)/g, '$1') // cmd-Escape: f^ormat → format
    .replace(/["']/g, (q) => q) // Anführungszeichen bleiben (Pfade)
    .replace(/[ \s]+/g, ' ')
    .trim()
    .toLowerCase();
}

const SYSTEM_DIRS = String.raw`(?:^|[\s"'=,])(?:[a-z]:\\?)?\\?(?:windows|program files(?: \(x86\))?|programdata|system volume information|\$recycle\.bin|recovery|boot|efi|users\\(?:default|public|all users))(?:\\|"|'|\s|$|\*)`;
const ENV_SYSTEM = String.raw`\$env:(?:windir|systemroot|systemdrive|programfiles(?:\(x86\))?|programdata|allusersprofile|commonprogramfiles)|%(?:windir|systemroot|systemdrive|programfiles|programdata)%`;
const DELETE_CMD = String.raw`(?:^|[;|&({\s])(?:remove-item|ri|rm|rmdir|rd|del|erase)(?=\s|$)`;

/** @type {{ id: string, label: string, test: (n: string) => boolean }[]} */
const BLOCK_RULES = [
  { id: 'disk', label: 'Formatieren oder Partitionieren', test: (n) => /(^|[;|&({\s])(format-volume|clear-disk|initialize-disk|new-partition|remove-partition|resize-partition|set-partition|set-disk|diskpart|format(\.com)?)(?=\s|$)/.test(n) || /\bmkfs\b/.test(n) },
  { id: 'boot', label: 'Startkonfiguration ändern', test: (n) => /\b(bcdedit|bootrec|bcdboot)\b/.test(n) },
  { id: 'reg-hklm', label: 'Registry unter HKLM löschen', test: (n) => /\breg(\.exe)?\s+delete\s+["']?(hklm|hkey_local_machine)\b/.test(n) || /\b(remove-item|ri|rm|del|remove-itemproperty|rp|clear-item)\b[^;|]*\b(hklm:|hkey_local_machine|registry::hkey_local_machine)/.test(n) },
  { id: 'defender', label: 'Virenschutz ausschalten', test: (n) => /set-mppreference\b[^;|]*-(disable\w*|exclusion\w*)/.test(n) || /add-mppreference\b[^;|]*-exclusion/.test(n) || /\b(stop-service|set-service|sc(\.exe)?\s+(stop|config|delete))\b[^;|]*\b(windefend|wdnissvc|sense|securityhealthservice|wscsvc)\b/.test(n) || /\bdisableantispyware\b|\bdisablerealtimemonitoring\b/.test(n) },
  { id: 'firewall', label: 'Firewall ausschalten', test: (n) => /\bnetsh\b[^;|]*\b(advfirewall|firewall)\b[^;|]*\b(state\s+off|disable|opmode\s+disable|reset)\b/.test(n) || /set-netfirewallprofile\b[^;|]*-enabled\s+(\$?false|0)\b/.test(n) || /\b(stop-service|set-service|sc(\.exe)?\s+(stop|config))\b[^;|]*\bmpssvc\b/.test(n) || /\b(disable-netfirewallrule|remove-netfirewallrule)\b/.test(n) },
  { id: 'download-run', label: 'Herunterladen und ausführen', test: (n) => /\b(iex|invoke-expression)\b/.test(n) || /-(e|ec|en|enc|enco|encod|encode|encoded|encodedc\w*)\s+[a-z0-9+/=]{8,}/.test(n) || /frombase64string/.test(n) || (/\b(iwr|irm|invoke-webrequest|invoke-restmethod|curl(\.exe)?|wget|start-bitstransfer|bitsadmin|certutil|downloadstring|downloadfile|net\.webclient|system\.net\.http)\b/.test(n) && /(\|\s*(&|\.|powershell|pwsh|cmd)|\bstart-process\b|\bsaps\b|\bstart\s|\.(exe|msi|bat|cmd|ps1|vbs|js|scr|dll)\b|\b(powershell|pwsh|cmd|mshta|rundll32|regsvr32|wscript|cscript)\b|&\s*\(|-urlcache)/.test(n)) || /\b(mshta|regsvr32|rundll32)\b[^;|]*(https?:|\\\\)/.test(n) },
  { id: 'credentials', label: 'Anmeldedaten oder Konten ändern', test: (n) => /\bnet(1)?(\.exe)?\s+(user|localgroup|accounts)\b/.test(n) || /\b(new|set|remove|enable|disable|rename)-localuser\b|\b(add|remove)-localgroupmember\b/.test(n) || /\b(cmdkey|vaultcmd)\b/.test(n) || /\b(set-adaccountpassword|set-aduser|new-aduser)\b/.test(n) || /\breg(\.exe)?\s+save\b[^;|]*\b(sam|security|system)\b/.test(n) || /\\config\\(sam|security)\b/.test(n) || /\bmimikatz\b|\bsekurlsa\b|\blsass\b/.test(n) || /\bget-credential\b|\bconvertfrom-securestring\b/.test(n) },
  { id: 'elevate', label: 'Adminrechte (RunAs)', test: (n) => /-verb\s+["']?runas\b/.test(n) || /(^|[;|&\s])(runas|sudo|gsudo|psexec|nircmd\s+elevate)(\.exe)?(?=\s|$)/.test(n) || /set-executionpolicy\b[^;|]*\b(unrestricted|bypass)\b/.test(n) },
  { id: 'shadow', label: 'Sicherungen oder Wiederherstellung löschen', test: (n) => /\bvssadmin\b[^;|]*\b(delete|resize)\b/.test(n) || /\bwbadmin\b[^;|]*\bdelete\b/.test(n) || /\bcipher\b[^;|]*\/w\b/.test(n) || /\bwmic\b[^;|]*shadowcopy[^;|]*delete/.test(n) || /\bdisable-computerrestore\b/.test(n) },
  { id: 'ownership', label: 'Besitz von Systemordnern übernehmen', test: (n) => /\b(takeown|icacls|set-acl)\b/.test(n) && new RegExp(`${SYSTEM_DIRS}|${ENV_SYSTEM}|\\b[a-z]:\\\\?(\\s|$|"|')`).test(n) },
  { id: 'delete-root', label: 'Laufwerk oder Systemordner löschen', test: (n) => new RegExp(DELETE_CMD).test(n) && (new RegExp(`${DELETE_CMD}[^;|]*(\\s|["'])(?:[a-z]:\\\\?\\*?|\\\\\\*?|/\\*?)(?=["']?(\\s|$|;))`).test(n) || new RegExp(`${DELETE_CMD}[^;|]*(${SYSTEM_DIRS}|${ENV_SYSTEM})`).test(n) || /\b(remove-item|ri|rm|del)\b[^;|]*\b(hkcu:|hklm:|env:|function:|variable:|cert:)/.test(n)) },
  { id: 'delete-outside', label: 'Rekursiv ausserhalb des Benutzerordners löschen', test: (n) => recursiveOutsideHome(n) },
  { id: 'delete-piped', label: 'Löschen über eine Pipe ausserhalb des Benutzerordners', test: (n) => /\|\s*(remove-item|ri|rm|del|erase|rd|rmdir)(?=\s|$)/.test(n) && (outsideHomePaths(n) || /\.\.([\\/]|$|\s|["'])/.test(n) || new RegExp(`${SYSTEM_DIRS}|${ENV_SYSTEM}`).test(n)) },
];

/** Rekursives Löschen nur im Benutzerordner: absolute Pfade ausserhalb, «..» oder andere Laufwerke sperren */
function recursiveOutsideHome(n) {
  const re = new RegExp(`${DELETE_CMD}([^;|]*)`, 'g');
  let m;
  while ((m = re.exec(n))) {
    const args = m[1];
    const recursive = /(^|\s)(-r|-re|-rec|-recu|-recur|-recurs|-recurse|\/s)(\s|$|:)/.test(args) || /^\s*(rd|rmdir)\b/.test(m[0].trim());
    if (!recursive) continue;
    if (/\.\.([\\/]|$|\s|["'])/.test(args)) return true;
    // Absolute Pfade: nur unter dem Benutzerordner
    if (outsideHomePaths(args)) return true;
  }
  return false;
}

/** Enthält der Text einen absoluten Pfad, der nicht im Benutzerordner liegt? */
function outsideHomePaths(text) {
  const paths = text.match(/["']?(?:[a-z]:\\?|\\\\|\$env:\w+|%\w+%|~|\$home)[^\s"';|]*/g) || [];
  for (const raw of paths) {
    const p = raw.replace(/^["']/, '');
    if (/^(~|\$home|\$env:userprofile|%userprofile%)([\\/]|$)/.test(p)) continue;
    if (/^[a-z]:\\users\\[^\\*?]+\\[^*?]/.test(p) && !/^[a-z]:\\users\\(default|public|all users)\\/.test(p)) continue;
    return true;
  }
  return false;
}

/**
 * @param {string} command
 * @returns {{ ok: true, readOnly: boolean, name: string } | { ok: false, blocked: boolean, reason: string, rule?: string }}
 */
function check(command) {
  const raw = String(command ?? '');
  if (!raw.trim()) return { ok: false, blocked: false, reason: 'Leerer Befehl.' };
  if (raw.length > MAX_COMMAND) return { ok: false, blocked: false, reason: `Befehl zu lang (max. ${MAX_COMMAND} Zeichen).` };
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f‪-‮⁦-⁩]/.test(raw)) return { ok: false, blocked: true, reason: 'Unsichtbare Steuerzeichen im Befehl.', rule: 'hidden' };
  const n = normalize(raw);
  for (const rule of BLOCK_RULES) {
    if (rule.test(n)) return { ok: false, blocked: true, reason: `Gesperrt: ${rule.label}. Das führt Buddy auch mit Freigabe nicht aus.`, rule: rule.id };
  }
  return { ok: true, readOnly: isReadOnly(n), name: commandName(n) };
}

/** Name des ersten Befehls (für «Immer erlauben») */
function commandName(n) {
  const first = n.split(/\s/)[0].replace(/\.exe$/, '');
  return READ_ONLY_ALIASES[first] || first;
}

/** Rein lesend = genau ein Befehl aus der Liste, ohne Pipes, Verkettung, Umleitung, Unterausdruck, Skriptblock */
function isReadOnly(n) {
  if (/[|;&><`$(){}\[\]@]|\r|\n/.test(n)) return false;
  if (READ_ONLY_FORBIDDEN_ARGS.test(n)) return false;
  return READ_ONLY.includes(commandName(n));
}

/** Liste «Immer erlauben» aus den Einstellungen bereinigen */
function cleanAllowList(list) {
  return [...new Set((Array.isArray(list) ? list : []).map((x) => String(x).toLowerCase()).filter((x) => READ_ONLY.includes(x)))];
}

module.exports = { check, normalize, isReadOnly, commandName, cleanAllowList, READ_ONLY, MAX_COMMAND, BLOCK_RULES };
