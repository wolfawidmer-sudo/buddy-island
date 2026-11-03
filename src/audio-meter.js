// Echter Musik-Visualizer: liest den Pegel der Windows-Tonausgabe über die WASAPI-
// Pegelanzeige (IAudioMeterInformation, wie der Lautstärkemixer). Es wird nichts
// aufgenommen, gespeichert oder verschickt, nur Spitzenwerte (0 bis 1) pro Kanal.
// Der Helfer läuft nur, solange Musik spielt und die Balken sichtbar sind.

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const METER_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
[ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")] class MMDeviceEnumeratorCom {}
[Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IMMDeviceEnumerator {
  int NotImpl1();
  [PreserveSig] int GetDefaultAudioEndpoint(int dataFlow, int role, out IMMDevice ppDevice);
}
[Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IMMDevice {
  [PreserveSig] int Activate(ref Guid iid, int dwClsCtx, IntPtr pActivationParams, [MarshalAs(UnmanagedType.IUnknown)] out object ppInterface);
}
[Guid("C02216F6-8C67-4B5B-9D00-D008E73E0064"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IAudioMeterInformation {
  [PreserveSig] int GetPeakValue(out float pfPeak);
  [PreserveSig] int GetMeteringChannelCount(out int pnChannelCount);
  [PreserveSig] int GetChannelsPeakValues(int u32ChannelCount, [Out, MarshalAs(UnmanagedType.LPArray)] float[] afPeakValues);
}
public static class BuddyMeter {
  static IAudioMeterInformation meter;
  public static void Init() {
    var e = (IMMDeviceEnumerator)(new MMDeviceEnumeratorCom());
    IMMDevice d;
    Marshal.ThrowExceptionForHR(e.GetDefaultAudioEndpoint(0, 1, out d));
    Guid iid = typeof(IAudioMeterInformation).GUID;
    object o;
    Marshal.ThrowExceptionForHR(d.Activate(ref iid, 23, IntPtr.Zero, out o));
    meter = (IAudioMeterInformation)o;
  }
  public static string Read() {
    if (meter == null) Init();
    float p; meter.GetPeakValue(out p);
    int c; meter.GetMeteringChannelCount(out c);
    float l = p, r = p;
    if (c >= 2) { var v = new float[c]; meter.GetChannelsPeakValues(c, v); l = v[0]; r = v[1]; }
    return p.ToString("0.000", System.Globalization.CultureInfo.InvariantCulture) + "," +
           l.ToString("0.000", System.Globalization.CultureInfo.InvariantCulture) + "," +
           r.ToString("0.000", System.Globalization.CultureInfo.InvariantCulture);
  }
  public static void Reset() { meter = null; }
}
"@
$out = [Console]::Out
$reader = [Console]::In
[Console]::Out.WriteLine('READY')
while ($true) {
  try { $out.WriteLine([BuddyMeter]::Read()) } catch { [BuddyMeter]::Reset(); Start-Sleep -Milliseconds 500 }
  $out.Flush()
  Start-Sleep -Milliseconds 33
}
`;

function createAudioMeter({ scriptDir, onLevel, log = () => {} }) {
  let proc = null;
  let buffer = '';
  let failed = false;

  function start() {
    if (proc || failed || process.platform !== 'win32') return false;
    try {
      const file = path.join(scriptDir, 'buddy-meter.ps1');
      fs.mkdirSync(scriptDir, { recursive: true });
      fs.writeFileSync(file, '﻿' + METER_SCRIPT, 'utf8');
      proc = spawn('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', file], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
      proc.stdout.setEncoding('utf8');
      proc.stdout.on('data', (chunk) => {
        buffer += chunk;
        let nl;
        while ((nl = buffer.indexOf('\n')) !== -1) {
          const line = buffer.slice(0, nl).trim();
          buffer = buffer.slice(nl + 1);
          const [p, l, r] = line.split(',').map(Number);
          if (Number.isFinite(p)) onLevel({ p, l: Number.isFinite(l) ? l : p, r: Number.isFinite(r) ? r : p });
        }
      });
      let err = '';
      proc.stderr.setEncoding('utf8');
      proc.stderr.on('data', (d) => { err = (err + d).slice(-500); });
      proc.on('exit', (code) => {
        if (code && code !== 0) {
          failed = true; // nicht in einer Schleife neu starten
          log(`Pegelanzeige beendet (${code}): ${err.slice(-200)}`);
        }
        proc = null;
      });
      return true;
    } catch (e) {
      failed = true;
      log(`Pegelanzeige nicht verfügbar: ${e.message}`);
      return false;
    }
  }

  function stop() {
    if (!proc) return;
    try { proc.kill(); } catch { /* schon weg */ }
    proc = null;
    buffer = '';
  }

  return { start, stop, running: () => Boolean(proc), available: () => process.platform === 'win32' && !failed };
}

module.exports = { createAudioMeter, METER_SCRIPT };
