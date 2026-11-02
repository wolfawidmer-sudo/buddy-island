// Sprachsteuerung über die eingebaute Windows-Spracherkennung (kein extra Konto).
//  - «Hey Buddy»: kleines Wake-Word mit fester Grammatik, läuft nur wenn eingeschaltet
//  - Diktat: zuerst die bessere Online-Erkennung von Windows (wie Win+H),
//    sonst die Offline-Erkennung (System.Speech)
// Der Helfer startet nur bei Bedarf und beendet sich ohne Wake-Word nach 2 Minuten.

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const IDLE_MS = 2 * 60 * 1000;

const SCRIPT = String.raw`
param([int]$wake = 0)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
function Emit($obj) {
  [Console]::Out.WriteLine(($obj | ConvertTo-Json -Compress -Depth 3))
  [Console]::Out.Flush()
}

Add-Type -AssemblyName System.Speech
Add-Type -AssemblyName System.Runtime.WindowsRuntime
$asTaskGeneric = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
  $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation' + [char]96 + '1'
})[0]
function Await($op, $type, $ms) {
  $task = $asTaskGeneric.MakeGenericMethod($type).Invoke($null, @($op))
  if (-not $task.Wait($ms)) { throw 'Zeitüberschreitung' }
  $task.Result
}

# Offline-Erkenner in der passenden Sprache wählen
$ui = [System.Globalization.CultureInfo]::CurrentUICulture
$infos = @([System.Speech.Recognition.SpeechRecognitionEngine]::InstalledRecognizers())
$info = $infos | Where-Object { $_.Culture.Name -eq $ui.Name } | Select-Object -First 1
if (-not $info) { $info = $infos | Where-Object { $_.Culture.TwoLetterISOLanguageName -eq $ui.TwoLetterISOLanguageName } | Select-Object -First 1 }
if (-not $info) { $info = $infos | Where-Object { $_.Culture.TwoLetterISOLanguageName -eq 'de' } | Select-Object -First 1 }
if (-not $info) { $info = $infos | Select-Object -First 1 }

$rec = $null
$wakeGrammar = $null
$dictGrammar = $null
if ($info) {
  try {
    $rec = New-Object System.Speech.Recognition.SpeechRecognitionEngine($info)
    $rec.SetInputToDefaultAudioDevice()
    $choices = New-Object System.Speech.Recognition.Choices
    foreach ($p in @('hey buddy', 'hallo buddy', 'hi buddy', 'he buddy', 'okay buddy')) { $choices.Add($p) }
    $gb = New-Object System.Speech.Recognition.GrammarBuilder
    $gb.Culture = $info.Culture
    $gb.Append($choices)
    $wakeGrammar = New-Object System.Speech.Recognition.Grammar($gb)
    $wakeGrammar.Name = 'wake'
    $dictGrammar = New-Object System.Speech.Recognition.DictationGrammar
    $dictGrammar.Name = 'dict'
    $rec.LoadGrammar($wakeGrammar)
    $rec.LoadGrammar($dictGrammar)
  } catch {
    Emit @{ kind = 'error'; error = 'Mikrofon/Spracherkennung: ' + $_.Exception.Message }
    $rec = $null
  }
}

# Online-Diktat von Windows (bessere Qualität), falls erlaubt
$online = $null
try {
  [Windows.Media.SpeechRecognition.SpeechRecognizer, Windows.Media.SpeechRecognition, ContentType = WindowsRuntime] | Out-Null
  $online = New-Object Windows.Media.SpeechRecognition.SpeechRecognizer
  $online.Timeouts.InitialSilenceTimeout = [TimeSpan]::FromSeconds(6)
  $online.Timeouts.EndSilenceTimeout = [TimeSpan]::FromSeconds(1.2)
  $c = Await ($online.CompileConstraintsAsync()) ([Windows.Media.SpeechRecognition.SpeechRecognitionCompilationResult]) 15000
  if ([string]$c.Status -ne 'Success') { $online = $null }
} catch { $online = $null }

$lang = ''
if ($info) { $lang = $info.Culture.Name }
Emit @{ kind = 'ready'; offline = ($rec -ne $null); online = ($online -ne $null); language = $lang; wake = ($wake -eq 1 -and $rec -ne $null) }
if ($rec -eq $null -and $online -eq $null) { exit 0 }

function Listen {
  Emit @{ kind = 'listening' }
  $text = ''
  if ($online -ne $null) {
    try {
      $r = Await ($online.RecognizeAsync()) ([Windows.Media.SpeechRecognition.SpeechRecognitionResult]) 30000
      if ([string]$r.Status -eq 'Success') { $text = $r.Text }
    } catch { $text = '' }
  }
  if (-not $text -and $rec -ne $null) {
    try {
      $wakeGrammar.Enabled = $false
      $dictGrammar.Enabled = $true
      $rec.InitialSilenceTimeout = [TimeSpan]::FromSeconds(6)
      $rec.EndSilenceTimeout = [TimeSpan]::FromSeconds(1.2)
      $rec.BabbleTimeout = [TimeSpan]::FromSeconds(0)
      $r = $rec.Recognize([TimeSpan]::FromSeconds(6))
      if ($r -ne $null) { $text = $r.Text }
    } catch { }
  }
  if ($text) { Emit @{ kind = 'text'; text = $text } } else { Emit @{ kind = 'nothing' } }
}

$stdin = New-Object System.IO.StreamReader([Console]::OpenStandardInput())
$cmdTask = $stdin.ReadLineAsync()
$wakeOn = ($wake -eq 1 -and $rec -ne $null)

while ($true) {
  if ($cmdTask.IsCompleted) {
    $cmd = $cmdTask.Result
    if ($cmd -eq $null -or $cmd -eq 'quit') { break }
    $cmdTask = $stdin.ReadLineAsync()
    if ($cmd -eq 'listen') { Listen }
    continue
  }
  if ($wakeOn) {
    try {
      $wakeGrammar.Enabled = $true
      $dictGrammar.Enabled = $false
      $rec.BabbleTimeout = [TimeSpan]::FromSeconds(2)
      $r = $rec.Recognize([TimeSpan]::FromSeconds(1))
      if ($r -ne $null -and $r.Grammar.Name -eq 'wake' -and $r.Confidence -ge 0.6) {
        Emit @{ kind = 'wake' }
        Listen
      }
    } catch { Start-Sleep -Milliseconds 500 }
  } else {
    Start-Sleep -Milliseconds 150
  }
}
`;

function createVoice({ scriptDir, onEvent, log }) {
  let proc = null;
  let buffer = '';
  let wake = false;
  let idleTimer = null;
  let pendingListen = false;
  let info = { offline: false, online: false, language: '', wake: false, ready: false };

  function start() {
    if (proc || process.platform !== 'win32') return;
    const file = path.join(scriptDir, 'buddy-voice.ps1');
    fs.mkdirSync(scriptDir, { recursive: true });
    fs.writeFileSync(file, '﻿' + SCRIPT, 'utf8');
    const p = spawn('powershell.exe', [
      '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', file, '-wake', wake ? '1' : '0',
    ], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    proc = p;
    info = { ...info, ready: false };
    p.stdout.setEncoding('utf8');
    p.stdout.on('data', (chunk) => {
      buffer += chunk;
      let nl;
      while ((nl = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, nl).replace(/^﻿/, '').trim();
        buffer = buffer.slice(nl + 1);
        if (!line) continue;
        let msg;
        try { msg = JSON.parse(line); } catch { continue; }
        if (msg.kind === 'ready') {
          info = { offline: msg.offline, online: msg.online, language: msg.language || '', wake: msg.wake, ready: true };
          if (pendingListen) { pendingListen = false; write('listen'); }
        }
        if (msg.kind === 'error') log?.(`Sprache: ${msg.error}`);
        onEvent?.(msg);
        touch();
      }
    });
    let errText = '';
    p.stderr.setEncoding('utf8');
    p.stderr.on('data', (d) => { errText += d; });
    p.on('exit', () => {
      if (proc === p) proc = null;
      if (errText.trim()) log?.(`Sprach-Helfer: ${errText.trim().slice(0, 400)}`);
      if (pendingListen) { pendingListen = false; onEvent?.({ kind: 'unavailable' }); }
    });
    p.on('error', () => { if (proc === p) proc = null; });
    touch();
  }

  function write(cmd) {
    try { proc?.stdin.write(cmd + '\n'); } catch { /* weg */ }
  }

  // Ohne Wake-Word nach 2 Minuten beenden (spart RAM)
  function touch() {
    clearTimeout(idleTimer);
    if (!wake) idleTimer = setTimeout(stop, IDLE_MS);
  }

  function listen() {
    if (process.platform !== 'win32') {
      onEvent?.({ kind: 'unavailable' });
      return;
    }
    if (!proc) {
      pendingListen = true;
      start();
      return;
    }
    if (!info.ready) { pendingListen = true; return; }
    write('listen');
    touch();
  }

  function setWake(on) {
    wake = Boolean(on);
    stop();
    if (wake) start();
  }

  function stop() {
    clearTimeout(idleTimer);
    if (!proc) return;
    const p = proc;
    proc = null;
    try { p.stdin.write('quit\n'); } catch { /* egal */ }
    setTimeout(() => { try { p.kill(); } catch { /* weg */ } }, 1500);
  }

  return { listen, setWake, stop, info: () => ({ ...info, running: Boolean(proc) }) };
}

module.exports = { createVoice, SCRIPT };
