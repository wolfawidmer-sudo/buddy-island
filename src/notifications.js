// Liest neue Windows-Mitteilungen (WhatsApp, Mail, Discord …) über die
// Windows-Schnittstelle UserNotificationListener und zeigt sie im Island.
// Ein kleiner PowerShell-Helfer fragt alle 3 Sekunden nach – das kostet
// praktisch keine Rechenleistung. Inhalte bleiben auf dem PC.

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const POLL_SECONDS = 3;
const KEEP = 30;

const SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
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

try {
  [Windows.UI.Notifications.Management.UserNotificationListener, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null
  [Windows.UI.Notifications.KnownNotificationBindings, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null
  $listener = [Windows.UI.Notifications.Management.UserNotificationListener]::Current
  $access = Await ($listener.RequestAccessAsync()) ([Windows.UI.Notifications.Management.UserNotificationListenerAccessStatus])
  Emit @{ kind = 'status'; access = [string]$access }
  if ([string]$access -ne 'Allowed') { exit 0 }
} catch {
  Emit @{ kind = 'status'; access = 'Error'; error = $_.Exception.Message }
  exit 0
}

$listType = [System.Collections.Generic.IReadOnlyList[Windows.UI.Notifications.UserNotification]]
$seen = New-Object 'System.Collections.Generic.HashSet[uint32]'
$first = $true
while ($true) {
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
  Start-Sleep -Seconds ${POLL_SECONDS}
}
`;

function createNotificationWatcher({ scriptDir, onNotification, onStatus }) {
  let proc = null;
  let buffer = '';
  const recent = [];

  function start() {
    if (proc || process.platform !== 'win32') return;
    const file = path.join(scriptDir, 'buddy-notifications.ps1');
    fs.mkdirSync(scriptDir, { recursive: true });
    fs.writeFileSync(file, '﻿' + SCRIPT, 'utf8');
    proc = spawn('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', file], {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    // Läuft im Hintergrund mit niedriger Priorität
    try { require('os').setPriority(proc.pid, 10); } catch { /* egal */ }
    proc.stdout.setEncoding('utf8');
    proc.stdout.on('data', (chunk) => {
      buffer += chunk;
      let nl;
      while ((nl = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, nl).replace(/^\ufeff/, '').trim();
        buffer = buffer.slice(nl + 1);
        if (!line) continue;
        let msg;
        try { msg = JSON.parse(line); } catch { continue; }
        if (msg.kind === 'status') onStatus?.(msg.access, msg.error);
        if (msg.kind === 'notification') {
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
        }
      }
    });
    proc.on('exit', () => { proc = null; });
    proc.on('error', () => { proc = null; onStatus?.('Error', 'PowerShell nicht verfügbar'); });
  }

  function stop() {
    if (!proc) return;
    try { proc.kill(); } catch { /* weg */ }
    proc = null;
  }

  return { start, stop, recent: () => [...recent], clear: () => recent.splice(0) };
}

module.exports = { createNotificationWatcher };
