// Microsoft-Store-Version (MSIX-Paket)
//
// Läuft Buddy als Paket aus dem Microsoft Store, gilt:
//  - Updates kommen nur über den Store (eigener Updater und Rollback sind aus).
//  - Autostart läuft über die StartupTask aus dem Paket-Manifest (build/appx-extensions.xml),
//    nicht über den Registry-Eintrag von app.setLoginItemSettings (greift in MSIX nicht).
//  - Verknüpfungen legt Windows selbst an.
//  - Die Vosk-Laufzeit (libvosk.dll) liegt im Paket. Nachgeladen werden nur Sprachmodelle (Daten),
//    kein ausführbarer Code (Store-Richtlinie 10.2.2).
//
// Electron setzt process.windowsStore = true, wenn die App als AppX/MSIX läuft.

const fs = require('fs');
const path = require('path');

const STARTUP_TASK_ID = 'BuddyIslandStartup';
const REPORT_EMAIL = 'contact@buddy-island.top';

/** @param {{ windowsStore?: boolean, platform?: string }} [proc] */
function isStore(proc = process) {
  return proc.platform === 'win32' && proc.windowsStore === true;
}

// Ordner mit libvosk.dll im Paket (extraResources → resources/vosk), sonst null
/** @param {string|undefined} resourcesPath */
function bundledVoskDir(resourcesPath) {
  if (!resourcesPath) return null;
  const dir = path.join(resourcesPath, 'vosk');
  return fs.existsSync(path.join(dir, 'libvosk.dll')) ? dir : null;
}

// PowerShell für die StartupTask des Pakets. Der Kindprozess erbt die Paket-Identität,
// darum findet StartupTask.GetAsync die Aufgabe aus dem Manifest.
// Ausgabe: eine Zeile JSON { state, error? }
/** @param {'query'|'enable'|'disable'} action */
function startupTaskScript(action) {
  if (!['query', 'enable', 'disable'].includes(action)) throw new Error('Unbekannte Aktion');
  return `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Runtime.WindowsRuntime
$asTask = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation\`1' })[0]
function Await($op, [Type]$type) { $t = $asTask.MakeGenericMethod($type).Invoke($null, @($op)); $t.Wait(-1) | Out-Null; $t.Result }
try {
  [Windows.ApplicationModel.StartupTask, Windows.ApplicationModel, ContentType = WindowsRuntime] | Out-Null
  $task = Await ([Windows.ApplicationModel.StartupTask]::GetAsync('${STARTUP_TASK_ID}')) ([Windows.ApplicationModel.StartupTask])
  ${action === 'enable' ? "if ([string]$task.State -eq 'Disabled') { $null = Await ($task.RequestEnableAsync()) ([Windows.ApplicationModel.StartupTaskState]) }" : ''}
  ${action === 'disable' ? "if ([string]$task.State -eq 'Enabled') { $task.Disable() }" : ''}
  [Console]::Out.WriteLine((@{ state = [string]$task.State } | ConvertTo-Json -Compress))
} catch {
  [Console]::Out.WriteLine((@{ state = 'Error'; error = $_.Exception.Message } | ConvertTo-Json -Compress))
}
`;
}

// Antwort des Skripts lesen. DisabledByUser/DisabledByPolicy kann nur der Nutzer in Windows ändern.
/** @param {string} stdout */
function parseStartupTask(stdout) {
  const line = String(stdout || '').trim().split(/\r?\n/).filter(Boolean).pop() || '';
  try {
    const o = JSON.parse(line);
    const state = String(o.state || 'Error');
    return { state, enabled: state === 'Enabled' || state === 'EnabledByPolicy', blocked: /^DisabledBy(User|Policy)$/.test(state), error: o.error || null };
  } catch {
    return { state: 'Error', enabled: false, blocked: false, error: 'Keine Antwort von Windows.' };
  }
}

// «Antwort melden» (Store-Richtlinie 11.16): E-Mail-Entwurf mit Frage und Antwort.
// Der Nutzer sieht alles, bevor er sendet; nichts geht automatisch weg.
/** @param {{ question?: string, answer: string, version: string, lang?: string }} o */
function reportMailto({ question = '', answer, version, lang = 'de' }) {
  const cut = (s, n) => {
    const x = String(s || '').trim();
    return x.length > n ? `${x.slice(0, n)} …` : x;
  };
  const texts = {
    de: { subject: 'Antwort melden', intro: 'Diese Antwort von Buddy ist unpassend, weil:', q: 'Frage', a: 'Antwort' },
    en: { subject: 'Report a response', intro: 'This response from Buddy is inappropriate because:', q: 'Question', a: 'Response' },
    fr: { subject: 'Signaler une réponse', intro: 'Cette réponse de Buddy est inappropriée parce que :', q: 'Question', a: 'Réponse' },
  };
  const tx = texts[lang] || texts.en;
  const body = [
    tx.intro, '', '',
    '---',
    `${tx.q}: ${cut(question, 300)}`, '',
    `${tx.a}: ${cut(answer, 700)}`, '',
    `Buddy Island ${version}`,
  ].join('\n');
  // Manche Mailprogramme schneiden lange mailto-Links ab; darum Frage und Antwort gekürzt.
  return `mailto:${REPORT_EMAIL}?subject=${encodeURIComponent(`Buddy Island: ${tx.subject}`)}&body=${encodeURIComponent(body)}`;
}

// Paket-Familienname aus dem Programmpfad: …\WindowsApps\<Name>_<Version>_<Arch>_<Res>_<PublisherId>\app\Buddy Island.exe
/** @param {string} execPath */
function packageFamilyName(execPath) {
  const m = /[\\/]WindowsApps[\\/]([^\\/]+)[\\/]/i.exec(String(execPath || ''));
  if (!m) return null;
  const parts = m[1].split('_');
  if (parts.length < 5 || !parts[0] || !parts[parts.length - 1]) return null;
  return `${parts[0]}_${parts[parts.length - 1]}`;
}

// Im Paket schreibt Windows AppData-Dateien in einen privaten Ordner um (LocalCache).
// Der Explorer läuft ausserhalb des Pakets und sieht dort, wo Buddy «AppData\Roaming\Buddy Island»
// meint, nichts. Für «Log-Ordner öffnen» darum den echten Ordner nehmen.
/** @param {{ execPath: string, userData: string, appData: string, localAppData: string, exists?: (p: string) => boolean }} o */
function realDataDir({ execPath, userData, appData, localAppData, exists = fs.existsSync }) {
  const pfn = packageFamilyName(execPath);
  if (!pfn || !localAppData || !appData) return userData;
  const rel = path.relative(appData, userData);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return userData;
  const redirected = path.join(localAppData, 'Packages', pfn, 'LocalCache', 'Roaming', rel);
  return exists(redirected) ? redirected : userData;
}

module.exports = { packageFamilyName, realDataDir, STARTUP_TASK_ID, REPORT_EMAIL, isStore, bundledVoskDir, startupTaskScript, parseStartupTask, reportMailto };
