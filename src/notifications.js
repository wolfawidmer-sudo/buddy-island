// System-Helfer: ein einziger kleiner PowerShell-Prozess für
//  - neue Windows-Mitteilungen (UserNotificationListener)
//  - «Läuft gerade» aus der Windows-Mediensitzung (Spotify, YouTube, …)
//  - Spielmodus: läuft gerade ein Spiel oder eine Vollbild-App im Vordergrund?
// Er fragt alle paar Sekunden nach – das kostet praktisch keine Leistung.
// Inhalte bleiben auf dem PC.

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const KEEP = 30;

const SCRIPT = String.raw`
param([int]$notify = 1, [int]$media = 1, [int]$game = 1)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
Add-Type -AssemblyName System.Runtime.WindowsRuntime
$asTaskGeneric = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
  $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation' + [char]96 + '1'
})[0]
function Await($op, $type) {
  $task = $asTaskGeneric.MakeGenericMethod($type).Invoke($null, @($op))
  $task.Wait(-1) | Out-Null
  $task.Result
}
function Emit($obj) {
  [Console]::Out.WriteLine(($obj | ConvertTo-Json -Compress -Depth 4))
  [Console]::Out.Flush()
}

# --- Mitteilungen ---
$listener = $null
if ($notify -eq 1) {
  try {
    [Windows.UI.Notifications.Management.UserNotificationListener, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null
    [Windows.UI.Notifications.KnownNotificationBindings, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null
    $l = [Windows.UI.Notifications.Management.UserNotificationListener]::Current
    $access = Await ($l.RequestAccessAsync()) ([Windows.UI.Notifications.Management.UserNotificationListenerAccessStatus])
    Emit @{ kind = 'status'; access = [string]$access }
    if ([string]$access -eq 'Allowed') { $listener = $l }
  } catch {
    Emit @{ kind = 'status'; access = 'Error'; error = $_.Exception.Message }
  }
}

# --- Medien ---
$mediaMgr = $null
if ($media -eq 1) {
  try {
    [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager, Windows.Media.Control, ContentType = WindowsRuntime] | Out-Null
    [Windows.Storage.Streams.DataReader, Windows.Storage.Streams, ContentType = WindowsRuntime] | Out-Null
    $mediaMgr = Await ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager]::RequestAsync()) ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager])
    Emit @{ kind = 'mediaStatus'; ok = $true }
  } catch {
    Emit @{ kind = 'mediaStatus'; ok = $false; error = $_.Exception.Message }
  }
}

# --- Spielmodus: Windows meldet selbst, wenn ein Spiel/Vollbild läuft ---
$focusOk = $false
if ($game -eq 1) {
  try {
    Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class BuddyFocus {
  [DllImport("shell32.dll")] static extern int SHQueryUserNotificationState(out int state);
  [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);
  public static int State() { int s; return SHQueryUserNotificationState(out s) == 0 ? s : 0; }
  public static uint ForegroundProcess() { uint id; GetWindowThreadProcessId(GetForegroundWindow(), out id); return id; }
}
'@
    $focusOk = $true
  } catch {
    Emit @{ kind = 'error'; error = 'Spielmodus: ' + $_.Exception.Message }
  }
}
$lastFocus = ''
$mediaEvery = 2

if ($listener -eq $null -and $mediaMgr -eq $null -and -not $focusOk) { exit 0 }

function Read-Cover($props) {
  try {
    if ($props.Thumbnail -eq $null) { return '' }
    $stream = Await ($props.Thumbnail.OpenReadAsync()) ([Windows.Storage.Streams.IRandomAccessStreamWithContentType])
    if ($stream.Size -gt 600000) { return '' }
    $reader = New-Object Windows.Storage.Streams.DataReader($stream.GetInputStreamAt(0))
    $count = Await ($reader.LoadAsync([uint32]$stream.Size)) ([uint32])
    $bytes = New-Object byte[] $count
    $reader.ReadBytes($bytes)
    $type = $stream.ContentType
    if (-not $type) { $type = 'image/jpeg' }
    return 'data:' + $type + ';base64,' + [Convert]::ToBase64String($bytes)
  } catch { return '' }
}

$stdin = New-Object System.IO.StreamReader([Console]::OpenStandardInput())
$cmdTask = $stdin.ReadLineAsync()
$listType = [System.Collections.Generic.IReadOnlyList[Windows.UI.Notifications.UserNotification]]
$seen = New-Object 'System.Collections.Generic.HashSet[uint32]'
$first = $true
$lastMedia = ''
$tick = 0

while ($true) {
  # Befehle von Buddy (Musik steuern)
  if ($cmdTask.IsCompleted) {
    $cmd = $cmdTask.Result
    if ($cmd -eq $null -or $cmd -eq 'quit') { break }
    $cmdTask = $stdin.ReadLineAsync()
    if ($mediaMgr -ne $null) {
      try {
        $s = $mediaMgr.GetCurrentSession()
        if ($s -ne $null) {
          switch ($cmd) {
            'playpause' { Await ($s.TryTogglePlayPauseAsync()) ([bool]) | Out-Null }
            'next'      { Await ($s.TrySkipNextAsync()) ([bool]) | Out-Null }
            'previous'  { Await ($s.TrySkipPreviousAsync()) ([bool]) | Out-Null }
          }
          $lastMedia = ''
          $tick = -1
        }
      } catch { }
    }
  }

  # Mitteilungen alle 3 Sekunden
  if ($listener -ne $null -and ($tick % 3) -eq 0) {
    try {
      $list = Await ($listener.GetNotificationsAsync([Windows.UI.Notifications.NotificationKinds]::Toast)) $listType
      foreach ($n in $list) {
        if (-not $seen.Add($n.Id)) { continue }
        if ($first) { continue }
        $app = ''
        try { $app = $n.AppInfo.DisplayInfo.DisplayName } catch { }
        $texts = @()
        try {
          $binding = $n.Notification.Visual.GetBinding([Windows.UI.Notifications.KnownNotificationBindings]::ToastGeneric)
          if ($binding -ne $null) { $texts = @($binding.GetTextElements() | ForEach-Object { $_.Text }) }
        } catch { }
        Emit @{ kind = 'notification'; id = $n.Id; app = $app; texts = $texts; time = $n.CreationTime.ToUnixTimeMilliseconds() }
      }
      $first = $false
    } catch {
      Emit @{ kind = 'error'; error = $_.Exception.Message }
    }
  }

  # Medien: alle 2 Sekunden, solange etwas läuft oder pausiert ist, sonst alle 5 (spart Rechenzeit im Leerlauf).
  # Gemeldet wird nur bei Änderung.
  if ($mediaMgr -ne $null -and ($tick % $mediaEvery) -eq 0) {
    try {
      $s = $mediaMgr.GetCurrentSession()
      if ($s -eq $null) {
        $mediaEvery = 5
        if ($lastMedia -ne 'none') { Emit @{ kind = 'media'; playing = $false; title = '' }; $lastMedia = 'none' }
      } else {
        $info = $s.GetPlaybackInfo()
        $status = [string]$info.PlaybackStatus
        # Auch pausiert alle 2 s: Weiterspielen soll der Visualizer sofort merken
        if ($status -eq 'Playing' -or $status -eq 'Paused') { $mediaEvery = 2 } else { $mediaEvery = 5 }
        $props = Await ($s.TryGetMediaPropertiesAsync()) ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionMediaProperties])
        $key = $s.SourceAppUserModelId + '|' + $props.Title + '|' + $props.Artist + '|' + $status
        if ($key -ne $lastMedia) {
          $trackChanged = -not $lastMedia.StartsWith($s.SourceAppUserModelId + '|' + $props.Title + '|')
          $cover = ''
          if ($trackChanged) { $cover = Read-Cover $props }
          Emit @{ kind = 'media'; app = $s.SourceAppUserModelId; title = $props.Title; artist = $props.Artist; album = $props.AlbumTitle; status = $status; playing = ($status -eq 'Playing'); cover = $cover; trackChanged = $trackChanged }
          $lastMedia = $key
        }
      }
    } catch { }
  }

  # Spielmodus alle 2 Sekunden prüfen
  if ($focusOk -and ($tick % 2) -eq 1) {
    try {
      $st = [BuddyFocus]::State()
      $fgId = [BuddyFocus]::ForegroundProcess()
      $name = ''
      try { $name = (Get-Process -Id $fgId -ErrorAction Stop).ProcessName } catch { }
      $key = [string]$st + '|' + $name
      if ($key -ne $lastFocus) {
        Emit @{ kind = 'focus'; state = $st; process = $name }
        $lastFocus = $key
      }
    } catch { }
  }

  $tick++
  Start-Sleep -Milliseconds 1000
}
`;

// Bekannte Spiele (Prozessnamen, klein geschrieben). Dazu zählen alle
// Unreal-Engine-Spiele («…-win64-shipping»).
const GAMES = new Set([
  'valorant', 'valorant-win64-shipping', 'leagueoflegends', 'league of legends', 'cs2', 'csgo',
  'fortniteclient-win64-shipping', 'rocketleague', 'gta5', 'gta5_enhanced', 'rdr2', 'minecraft.windows',
  'robloxplayerbeta', 'r5apex', 'r5apex_dx12', 'overwatch', 'eldenring', 'geometrydash', 'fc24', 'fc25', 'fc26',
  'rainbowsix', 'rainbowsix_vulkan', 'destiny2', 'cod', 'valheim', 'terraria', 'stardew valley', 'cyberpunk2077',
  'witcher3', 'bg3', 'bg3_dx11', 'hogwartslegacy', 'helldivers2', 'discovery', 'dota2', 'tslgame', 'hearthstone',
  'wow', 'diablo iv', 'starfield', 'forzahorizon5', 'rust', 'dayz_x64', 'warframe.x64', 'genshinimpact',
  'zenlesszonezero', 'starrail', 'osu!', 'ts4_x64', 'eurotrucks2', 'amongus', 'deadlock', 'project8',
]);
const FULLSCREEN_STATES = new Set([2, 3, 4]); // Vollbild-App, Direct3D-Vollbild, Präsentation

function isGame(state, processName) {
  const name = String(processName || '').toLowerCase();
  return FULLSCREEN_STATES.has(Number(state)) || GAMES.has(name) || /-win64-shipping$/.test(name);
}

function createSystemWatcher({ scriptDir, onNotification, onStatus, onMedia, onMediaStatus, onFocus, log }) {
  let proc = null;
  let buffer = '';
  let options = { notify: true, media: true, game: true };
  const recent = [];
  let nowPlaying = null;

  function start(next = options) {
    options = { ...next };
    stop();
    if (process.platform !== 'win32' || (!options.notify && !options.media && !options.game)) return;
    const file = path.join(scriptDir, 'buddy-system.ps1');
    fs.mkdirSync(scriptDir, { recursive: true });
    fs.writeFileSync(file, '﻿' + SCRIPT, 'utf8');
    const p = spawn('powershell.exe', [
      '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', file,
      '-notify', options.notify ? '1' : '0', '-media', options.media ? '1' : '0', '-game', options.game ? '1' : '0',
    ], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    proc = p;
    // Läuft im Hintergrund mit niedriger Priorität
    try { require('os').setPriority(p.pid, 10); } catch { /* egal */ }
    p.stdout.setEncoding('utf8');
    p.stdout.on('data', (chunk) => {
      buffer += chunk;
      let nl;
      while ((nl = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, nl).replace(/^﻿/, '').trim();
        buffer = buffer.slice(nl + 1);
        if (line) handle(line);
      }
    });
    let errText = '';
    p.stderr.setEncoding('utf8');
    p.stderr.on('data', (d) => { errText += d; });
    p.on('exit', (code) => {
      if (proc === p) proc = null;
      if (errText.trim()) log?.(`System-Helfer beendet (${code}): ${errText.trim().slice(0, 500)}`);
    });
    p.on('error', (err) => {
      if (proc === p) proc = null;
      onStatus?.('Error', err.message);
    });
  }

  function handle(line) {
    let msg;
    try { msg = JSON.parse(line); } catch { return; }
    if (msg.kind === 'status') onStatus?.(msg.access, msg.error);
    else if (msg.kind === 'mediaStatus') onMediaStatus?.(msg.ok, msg.error);
    else if (msg.kind === 'error') log?.(`System-Helfer: ${msg.error}`);
    else if (msg.kind === 'focus') onFocus?.({ game: isGame(msg.state, msg.process), state: Number(msg.state), process: String(msg.process || '') });
    else if (msg.kind === 'notification') {
      const texts = (Array.isArray(msg.texts) ? msg.texts : [msg.texts]).filter(Boolean).map(String);
      const item = {
        id: msg.id,
        app: String(msg.app || 'Mitteilung'),
        title: texts[0] || '',
        body: texts.slice(1).join(' '),
        time: Number(msg.time) || Date.now(),
      };
      recent.unshift(item);
      recent.splice(KEEP);
      onNotification?.(item);
    } else if (msg.kind === 'media') {
      const cover = msg.cover || (msg.trackChanged ? '' : nowPlaying?.cover || '');
      nowPlaying = msg.title
        ? {
          app: appName(msg.app),
          title: String(msg.title || ''),
          artist: String(msg.artist || ''),
          album: String(msg.album || ''),
          playing: Boolean(msg.playing),
          cover,
          trackChanged: Boolean(msg.trackChanged),
        }
        : null;
      onMedia?.(nowPlaying);
    }
  }

  function appName(id) {
    const s = String(id || '');
    if (/spotify/i.test(s)) return 'Spotify';
    if (/chrome/i.test(s)) return 'Chrome';
    if (/msedge|edge/i.test(s)) return 'Edge';
    if (/firefox/i.test(s)) return 'Firefox';
    if (/zunemusic|music/i.test(s)) return 'Musik';
    if (/vlc/i.test(s)) return 'VLC';
    return s.replace(/\.exe$/i, '').split(/[!\\.]/).filter(Boolean).pop() || 'Medien';
  }

  function media(command) {
    if (!proc || !['playpause', 'next', 'previous'].includes(command)) return false;
    try { proc.stdin.write(command + '\n'); return true; } catch { return false; }
  }

  function stop() {
    if (!proc) return;
    const p = proc;
    proc = null;
    try { p.stdin.write('quit\n'); } catch { /* egal */ }
    setTimeout(() => { try { p.kill(); } catch { /* weg */ } }, 1500);
  }

  return {
    start,
    stop,
    media,
    nowPlaying: () => nowPlaying,
    recent: () => [...recent],
    clear: () => recent.splice(0),
  };
}

module.exports = { createSystemWatcher, isGame, SCRIPT };
