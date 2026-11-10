// Sprachsteuerung über die eingebaute Windows-Spracherkennung (kein extra Konto).
//  - Wakeword («Hey Buddy» oder ein eigenes, siehe src/wakeword.js): feste Wortliste,
//    läuft nur wenn eingeschaltet
//  - Diktat: zuerst die bessere Online-Erkennung von Windows (wie Win+H),
//    sonst die Offline-Erkennung (System.Speech)
// Der Helfer startet nur bei Bedarf und beendet sich ohne Wake-Word nach 2 Minuten.

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const { DEFAULT_WAKE_WORD, wakePhrases, minConfidence, encodePhrases } = require('./wakeword');
const { missingWords, grammarWords } = require('./vosk');

const b64 = (x) => Buffer.from(String(x), 'utf8').toString('base64');

const IDLE_MS = 2 * 60 * 1000;

const SCRIPT = String.raw`
param([int]$wake = 0, [string]$words = '', [double]$minconf = 0.6, [string]$engine = 'windows', [string]$voskdll = '', [string]$voskmodel = '', [string]$grammar = '')
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

$list = @('hey buddy', 'hallo buddy', 'hi buddy', 'he buddy', 'okay buddy')
if ($words) {
  # Eine Zeile pro Wakeword-Variante (kein JSON: Windows PowerShell 5.1 liefert JSON-Listen als ein einziges Objekt)
  try { $list = @([System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($words)) -split [char]10 | ForEach-Object { $_.Trim() } | Where-Object { $_ }) } catch { }
}
$list = @($list | Where-Object { $_ -is [string] -and $_.Length -gt 0 -and $_.Length -le 48 })
if ($list.Count -eq 0) { $list = @('hey buddy', 'hallo buddy', 'hi buddy', 'he buddy', 'okay buddy') }

$rec = $null
$wakeGrammar = $null
$dictGrammar = $null
if ($info) {
  try {
    $rec = New-Object System.Speech.Recognition.SpeechRecognitionEngine($info)
    $rec.SetInputToDefaultAudioDevice()
    $choices = New-Object System.Speech.Recognition.Choices
    foreach ($p in $list) { $choices.Add($p) }
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


# Vosk für das Wakeword (falls installiert); sonst die Windows-Erkennung oben
$vosk = $false
if ($wake -eq 1 -and $engine -eq 'vosk' -and $voskdll -and $voskmodel) {
  try {
    $dllDir = [System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($voskdll))
    $modelDir = [System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($voskmodel))

$voskCode = @"
using System;
using System.IO;
using System.Text;
using System.Threading;
using System.Runtime.InteropServices;

public static class BuddyVosk {
  const CallingConvention C = CallingConvention.Cdecl;
  [DllImport("kernel32", CharSet = CharSet.Unicode, SetLastError = true)] static extern bool SetDllDirectory(string p);
  [DllImport("kernel32", CharSet = CharSet.Unicode, SetLastError = true)] static extern IntPtr LoadLibrary(string p);
  [DllImport("kernel32", CharSet = CharSet.Unicode)] static extern uint GetShortPathName(string l, StringBuilder s, uint n);
  [DllImport("libvosk", CallingConvention = C)] static extern void vosk_set_log_level(int l);
  [DllImport("libvosk", CallingConvention = C)] static extern IntPtr vosk_model_new(byte[] path);
  [DllImport("libvosk", CallingConvention = C)] static extern void vosk_model_free(IntPtr m);
  [DllImport("libvosk", CallingConvention = C)] static extern IntPtr vosk_recognizer_new_grm(IntPtr m, float rate, byte[] grm);
  [DllImport("libvosk", CallingConvention = C)] static extern void vosk_recognizer_set_words(IntPtr r, int on);
  [DllImport("libvosk", CallingConvention = C)] static extern int vosk_recognizer_accept_waveform(IntPtr r, byte[] data, int len);
  [DllImport("libvosk", CallingConvention = C)] static extern IntPtr vosk_recognizer_result(IntPtr r);
  [DllImport("libvosk", CallingConvention = C)] static extern void vosk_recognizer_reset(IntPtr r);
  [DllImport("libvosk", CallingConvention = C)] static extern void vosk_recognizer_free(IntPtr r);

  [StructLayout(LayoutKind.Sequential, Pack = 1)]
  struct WaveFormat { public ushort tag, channels; public uint rate, bytesPerSec; public ushort align, bits, size; }
  [DllImport("winmm")] static extern int waveInOpen(out IntPtr h, uint dev, ref WaveFormat f, IntPtr cb, IntPtr inst, uint flags);
  [DllImport("winmm")] static extern int waveInPrepareHeader(IntPtr h, IntPtr hdr, uint size);
  [DllImport("winmm")] static extern int waveInUnprepareHeader(IntPtr h, IntPtr hdr, uint size);
  [DllImport("winmm")] static extern int waveInAddBuffer(IntPtr h, IntPtr hdr, uint size);
  [DllImport("winmm")] static extern int waveInStart(IntPtr h);
  [DllImport("winmm")] static extern int waveInReset(IntPtr h);
  [DllImport("winmm")] static extern int waveInClose(IntPtr h);

  // WAVEHDR (x64): lpData 0, dwBufferLength 8, dwBytesRecorded 12, dwUser 16, dwFlags 24, dwLoops 28, lpNext 32, reserved 40
  const int HDR = 48, N = 4, BUF = 3200; // 4 × 100 ms bei 16 kHz, 16 Bit, mono
  static IntPtr model = IntPtr.Zero, rec = IntPtr.Zero, wave = IntPtr.Zero;
  static IntPtr[] hdrs = new IntPtr[N];

  static byte[] Z(string s, Encoding e) { byte[] b = e.GetBytes(s); byte[] z = new byte[b.Length + 1]; Array.Copy(b, z, b.Length); return z; }
  static string Str(IntPtr p) {
    if (p == IntPtr.Zero) return "";
    int n = 0; while (Marshal.ReadByte(p, n) != 0) n++;
    byte[] b = new byte[n]; Marshal.Copy(p, b, 0, n); return Encoding.UTF8.GetString(b);
  }
  // Kaldi öffnet Dateien mit schmalen Pfaden: kurzer 8.3-Pfad, falls der Benutzername Umlaute hat
  static string Short(string p) { StringBuilder sb = new StringBuilder(1024); uint n = GetShortPathName(p, sb, 1024); return n > 0 && n < 1024 ? sb.ToString() : p; }

  public static string Init(string dllDir, string modelDir, string[] words) {
    SetDllDirectory(dllDir);
    if (LoadLibrary(Path.Combine(dllDir, "libvosk.dll")) == IntPtr.Zero) return "libvosk.dll nicht ladbar (" + Marshal.GetLastWin32Error() + ")";
    vosk_set_log_level(0);
    model = vosk_model_new(Z(Short(modelDir), Encoding.Default));
    if (model == IntPtr.Zero) return "Sprachmodell nicht ladbar";
    StringBuilder g = new StringBuilder("[");
    foreach (string p in words) g.Append("\"").Append(p.Replace("\\", "").Replace("\"", "")).Append("\",");
    g.Append("\"[unk]\"]");
    rec = vosk_recognizer_new_grm(model, 16000f, Z(g.ToString(), Encoding.UTF8));
    if (rec == IntPtr.Zero) return "Erkenner nicht erstellt";
    vosk_recognizer_set_words(rec, 1);
    return "";
  }

  public static string StartMic() {
    if (wave != IntPtr.Zero) return "";
    WaveFormat f = new WaveFormat(); f.tag = 1; f.channels = 1; f.rate = 16000; f.bytesPerSec = 32000; f.align = 2; f.bits = 16; f.size = 0;
    int r = waveInOpen(out wave, 0xFFFFFFFF, ref f, IntPtr.Zero, IntPtr.Zero, 0);
    if (r != 0) { wave = IntPtr.Zero; return "Mikrofon nicht verfügbar (" + r + ")"; }
    for (int i = 0; i < N; i++) {
      IntPtr h = Marshal.AllocHGlobal(HDR);
      for (int k = 0; k < HDR; k++) Marshal.WriteByte(h, k, 0);
      Marshal.WriteIntPtr(h, 0, Marshal.AllocHGlobal(BUF));
      Marshal.WriteInt32(h, 8, BUF);
      hdrs[i] = h;
      waveInPrepareHeader(wave, h, HDR);
      waveInAddBuffer(wave, h, HDR);
    }
    waveInStart(wave);
    return "";
  }

  public static void StopMic() {
    if (wave == IntPtr.Zero) return;
    waveInReset(wave);
    for (int i = 0; i < N; i++) {
      if (hdrs[i] == IntPtr.Zero) continue;
      waveInUnprepareHeader(wave, hdrs[i], HDR);
      Marshal.FreeHGlobal(Marshal.ReadIntPtr(hdrs[i], 0));
      Marshal.FreeHGlobal(hdrs[i]);
      hdrs[i] = IntPtr.Zero;
    }
    waveInClose(wave);
    wave = IntPtr.Zero;
    if (rec != IntPtr.Zero) vosk_recognizer_reset(rec);
  }

  // Wartet bis zu ms auf ein fertiges Stück Sprache; gibt das Vosk-Ergebnis (JSON) zurück oder null
  public static string Poll(int ms) {
    DateTime end = DateTime.UtcNow.AddMilliseconds(ms);
    byte[] buf = new byte[BUF];
    while (DateTime.UtcNow < end) {
      bool any = false;
      for (int i = 0; i < N && wave != IntPtr.Zero; i++) {
        IntPtr h = hdrs[i];
        if ((Marshal.ReadInt32(h, 24) & 1) == 0) continue; // WHDR_DONE
        any = true;
        int n = Marshal.ReadInt32(h, 12);
        if (n > 0) Marshal.Copy(Marshal.ReadIntPtr(h, 0), buf, 0, n);
        Marshal.WriteInt32(h, 12, 0);
        waveInAddBuffer(wave, h, HDR);
        if (n > 0 && vosk_recognizer_accept_waveform(rec, buf, n) == 1) return Str(vosk_recognizer_result(rec));
      }
      if (!any) Thread.Sleep(25);
    }
    return null;
  }

  public static void Free() {
    StopMic();
    if (rec != IntPtr.Zero) { vosk_recognizer_free(rec); rec = IntPtr.Zero; }
    if (model != IntPtr.Zero) { vosk_model_free(model); model = IntPtr.Zero; }
  }
}
"@
    
    Add-Type -TypeDefinition $voskCode -Language CSharp
    $gwords = @($list)
    if ($grammar) { try { $gwords = @([System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($grammar)) -split [char]10 | ForEach-Object { $_.Trim() } | Where-Object { $_ }) } catch { } }
    if ($gwords.Count -eq 0) { $gwords = @($list) }
    $err = [BuddyVosk]::Init($dllDir, $modelDir, [string[]]$gwords)
    if (-not $err) { $err = [BuddyVosk]::StartMic() }
    if ($err) { Emit @{ kind = 'error'; error = 'Vosk: ' + $err } } else { $vosk = $true }
  } catch {
    Emit @{ kind = 'error'; error = 'Vosk: ' + $_.Exception.Message }
  }
}

# Passt ein Vosk-Ergebnis zu einem der Wakewords? Nur am Anfang einer Äusserung
# («Hey Kiwi, …»), nicht mitten im Satz («… eine Kiwi zum Frühstück»), und sicher genug.
function VoskHit($json) {
  try { $r = $json | ConvertFrom-Json } catch { return $false }
  $text = ' ' + ([string]$r.text).Trim() + ' '
  foreach ($p in $list) {
    if ($text.StartsWith(' ' + $p + ' ')) {
      $n = $p.Split(' ').Count
      $words = @($r.result | Select-Object -First $n)
      if ($words.Count -lt $n) { return $true }
      $avg = ($words | Measure-Object -Property conf -Average).Average
      if ($avg -ge $minconf) { return $true }
    }
  }
  return $false
}

$lang = ''
if ($info) { $lang = $info.Culture.Name }
Emit @{ kind = 'ready'; offline = ($rec -ne $null); online = ($online -ne $null); language = $lang; wake = ($wake -eq 1 -and ($vosk -or $rec -ne $null)); engine = $(if ($vosk) { 'vosk' } else { 'windows' }) }
if ($rec -eq $null -and $online -eq $null -and -not $vosk) { exit 0 }

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
$wakeOn = ($wake -eq 1 -and ($vosk -or $rec -ne $null))

while ($true) {
  if ($cmdTask.IsCompleted) {
    $cmd = $cmdTask.Result
    if ($cmd -eq $null -or $cmd -eq 'quit') { break }
    $cmdTask = $stdin.ReadLineAsync()
    if ($cmd -eq 'listen') {
      if ($vosk) { [BuddyVosk]::StopMic() }
      Listen
      if ($vosk) { [BuddyVosk]::StartMic() | Out-Null }
    }
    continue
  }
  if ($wakeOn -and $vosk) {
    $res = [BuddyVosk]::Poll(300)
    if ($res -and (VoskHit $res)) {
      Emit @{ kind = 'wake' }
      [BuddyVosk]::StopMic()
      Listen
      [BuddyVosk]::StartMic() | Out-Null
    }
  } elseif ($wakeOn) {
    try {
      $wakeGrammar.Enabled = $true
      $dictGrammar.Enabled = $false
      $rec.BabbleTimeout = [TimeSpan]::FromSeconds(2)
      $r = $rec.Recognize([TimeSpan]::FromSeconds(1))
      if ($r -ne $null -and $r.Grammar.Name -eq 'wake' -and $r.Confidence -ge $minconf) {
        Emit @{ kind = 'wake' }
        Listen
      }
    } catch { Start-Sleep -Milliseconds 500 }
  } else {
    Start-Sleep -Milliseconds 150
  }
}
if ($vosk) { [BuddyVosk]::Free() }
`;

function createVoice({ scriptDir, onEvent, log, wakeWord = DEFAULT_WAKE_WORD }) {
  let engine = null; // { dllDir, modelDir } für Vosk, sonst Windows-Erkennung
  let proc = null;
  let buffer = '';
  let wake = false;
  let word = wakeWord;
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
      '-words', encodePhrases(wakePhrases(word)), '-minconf', String(minConfidence(word)),
      ...(engine ? ['-engine', 'vosk', '-voskdll', b64(engine.dllDir), '-voskmodel', b64(engine.modelDir),
        '-grammar', b64(grammarWords(engine.lang, wakePhrases(word)).join('\n'))] : []),
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
          info = { offline: msg.offline, online: msg.online, language: msg.language || '', wake: msg.wake, engine: msg.engine || 'windows', ready: true };
          if (pendingListen) { pendingListen = false; write('listen'); }
        }
        if (msg.kind === 'error') log?.(`Sprache: ${msg.error}`);
        onEvent?.(msg);
        touch();
      }
    });
    let errText = '';
    let oovSent = false;
    p.stderr.setEncoding('utf8');
    p.stderr.on('data', (d) => {
      // Vosk schreibt Protokollzeilen auf stderr: nur Warnungen und Fehler behalten
      const lines = String(d).split(/\r?\n/).filter((l) => l.trim() && !/^LOG \(/.test(l));
      if (lines.length) errText = (errText + lines.join('\n') + '\n').slice(-4000);
      const missing = missingWords(errText);
      if (missing.length && !oovSent) { oovSent = true; onEvent?.({ kind: 'wake-oov', words: missing }); }
    });
    p.on('exit', () => {
      if (proc === p) proc = null;
      if (errText.trim()) log?.(`Sprach-Helfer: ${errText.trim().slice(-400)}`);
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

  // Erkennung wählen: Vosk ({ dllDir, modelDir }) oder null = Windows-Erkennung
  function setEngine(next) {
    const same = JSON.stringify(next || null) === JSON.stringify(engine);
    engine = next || null;
    if (!same && wake) { stop(); start(); }
  }

  // Neues Wakeword: Helfer mit der neuen Wortliste neu starten (nur wenn er auf das Wort hört)
  function setWakeWord(next) {
    if (!next || next === word) return;
    word = next;
    if (wake) { stop(); start(); }
  }

  // Laufendes Zuhören abbrechen und das Mikrofon sofort freigeben
  function cancel() {
    pendingListen = false;
    if (proc) {
      const p = proc;
      proc = null;
      try { p.kill(); } catch { /* weg */ }
    }
    clearTimeout(idleTimer);
    if (wake) setTimeout(() => { if (!proc) start(); }, 400);
  }

  function stop() {
    clearTimeout(idleTimer);
    if (!proc) return;
    const p = proc;
    proc = null;
    try { p.stdin.write('quit\n'); } catch { /* egal */ }
    setTimeout(() => { try { p.kill(); } catch { /* weg */ } }, 1500);
  }

  return { listen, cancel, setWake, setWakeWord, setEngine, stop, wakeWord: () => word, engine: () => (engine ? 'vosk' : 'windows'), info: () => ({ ...info, running: Boolean(proc) }) };
}

module.exports = { createVoice, SCRIPT };
