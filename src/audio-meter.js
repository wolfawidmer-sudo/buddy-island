// Echte Audio-Analyse für den Musik-Visualizer (Island-Balken und Bildschirmrand).
//
// Ein kleiner C#-Helfer (über PowerShell geladen) nimmt per WASAPI-Loopback genau den Ton ab,
// den Windows gerade an das Standard-Ausgabegerät schickt. Ohne Wiedergabe liefert Windows
// keine Daten: Ist Spotify offen, aber pausiert, kommt nichts an, und der Visualizer bleibt ruhig.
// Aus dem Signal wird ~60-mal pro Sekunde eine FFT (2048 Punkte, Hann-Fenster) gerechnet und in
// Bass (20–150 Hz), Mitten (150–2000 Hz) und Höhen (2–12 kHz) zerlegt, mit automatischer
// Pegelanpassung pro Band (leise Lieder sind trotzdem sichtbar, laute übersteuern nicht).
// Es wird nichts aufgenommen, gespeichert oder verschickt: nur Zahlen pro Bild.
// Wechselt das Ausgabegerät, verbindet sich der Helfer selbst neu.

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const ANALYZER_CS = String.raw`
using System;
using System.Diagnostics;
using System.Globalization;
using System.Runtime.InteropServices;

[ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")] class BuddyMMDeviceEnumerator {}

[Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IBuddyDeviceEnumerator {
  [PreserveSig] int EnumAudioEndpoints(int dataFlow, int stateMask, out IntPtr devices);
  [PreserveSig] int GetDefaultAudioEndpoint(int dataFlow, int role, out IBuddyDevice device);
}

[Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IBuddyDevice {
  [PreserveSig] int Activate(ref Guid iid, int clsCtx, IntPtr activationParams, [MarshalAs(UnmanagedType.IUnknown)] out object iface);
  [PreserveSig] int OpenPropertyStore(int access, out IntPtr store);
  [PreserveSig] int GetId([MarshalAs(UnmanagedType.LPWStr)] out string id);
}

[Guid("1CB9AD4C-DBFA-4c32-B178-C2F568A703B2"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IBuddyAudioClient {
  [PreserveSig] int Initialize(int shareMode, int streamFlags, long bufferDuration, long periodicity, IntPtr format, IntPtr sessionGuid);
  [PreserveSig] int GetBufferSize(out uint frames);
  [PreserveSig] int GetStreamLatency(out long latency);
  [PreserveSig] int GetCurrentPadding(out uint padding);
  [PreserveSig] int IsFormatSupported(int shareMode, IntPtr format, out IntPtr closest);
  [PreserveSig] int GetMixFormat(out IntPtr format);
  [PreserveSig] int GetDevicePeriod(out long defaultPeriod, out long minimumPeriod);
  [PreserveSig] int Start();
  [PreserveSig] int Stop();
  [PreserveSig] int Reset();
  [PreserveSig] int SetEventHandle(IntPtr handle);
  [PreserveSig] int GetService(ref Guid iid, [MarshalAs(UnmanagedType.IUnknown)] out object service);
}

[Guid("C8ADBD64-E71E-48a0-A4DE-185C395CD317"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IBuddyCaptureClient {
  [PreserveSig] int GetBuffer(out IntPtr data, out uint frames, out uint flags, out ulong devicePosition, out ulong qpcPosition);
  [PreserveSig] int ReleaseBuffer(uint frames);
  [PreserveSig] int GetNextPacketSize(out uint frames);
}

public static class BuddyAudio {
  const int N = 2048;                 // FFT-Länge (bei 48 kHz ~43 ms)
  const int LOOPBACK = 0x00020000;    // AUDCLNT_STREAMFLAGS_LOOPBACK
  const uint SILENT = 0x2;            // AUDCLNT_BUFFERFLAGS_SILENT

  static readonly float[] ring = new float[N * 2];
  static int ringPos = 0;
  static readonly float[] window = Hann(N);
  static float[] env = new float[] { -30f, -30f, -30f };   // gleitendes Maximum pro Band (dB)
  static float bassAvg = 0f;
  static double lastBeat = -1;

  static float[] Hann(int n) {
    var w = new float[n];
    for (int i = 0; i < n; i++) w[i] = (float)(0.5 - 0.5 * Math.Cos(2 * Math.PI * i / (n - 1)));
    return w;
  }

  // Radix-2-FFT (in-place)
  public static void Fft(double[] re, double[] im) {
    int n = re.Length;
    for (int i = 1, j = 0; i < n; i++) {
      int bit = n >> 1;
      for (; (j & bit) != 0; bit >>= 1) j ^= bit;
      j ^= bit;
      if (i < j) { double t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t; }
    }
    for (int len = 2; len <= n; len <<= 1) {
      double ang = -2 * Math.PI / len;
      double wr = Math.Cos(ang), wi = Math.Sin(ang);
      for (int i = 0; i < n; i += len) {
        double cr = 1, ci = 0;
        for (int k = 0; k < len / 2; k++) {
          int a = i + k, b = a + len / 2;
          double tr = re[b] * cr - im[b] * ci, ti = re[b] * ci + im[b] * cr;
          re[b] = re[a] - tr; im[b] = im[a] - ti; re[a] += tr; im[a] += ti;
          double ncr = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = ncr;
        }
      }
    }
  }

  // Rohwerte: [rms, bass dB, mitten dB, höhen dB] für N Mono-Samples (auch für Tests)
  public static double[] Bands(float[] mono, int rate) {
    var re = new double[N]; var im = new double[N];
    double sq = 0;
    for (int i = 0; i < N; i++) { float s = mono[i]; sq += s * s; re[i] = s * window[i]; }
    Fft(re, im);
    double hz = (double)rate / N;
    double[] e = new double[3]; int[] c = new int[3];
    for (int k = 1; k < N / 2; k++) {
      double f = k * hz, m = re[k] * re[k] + im[k] * im[k];
      int band = f < 20 ? -1 : f < 150 ? 0 : f < 2000 ? 1 : f < 12000 ? 2 : -1;
      if (band < 0) continue;
      e[band] += m; c[band]++;
    }
    var outv = new double[4];
    outv[0] = Math.Sqrt(sq / N);
    for (int b = 0; b < 3; b++) outv[b + 1] = 10 * Math.Log10(e[b] / Math.Max(1, c[b]) / (N * N) + 1e-12);
    return outv;
  }

  // Normalisiert pro Band: 0 = 30 dB unter dem gleitenden Maximum, 1 = Maximum (leicht gekrümmt,
  // damit Schläge sich deutlich vom Rest abheben). Das Maximum steigt sofort und sinkt langsam
  // (~1,2 dB/s): leise Passagen bleiben sichtbar leiser, ein Drop danach schlägt deutlich aus.
  public static double[] Normalize(double[] raw, double dt) {
    var lv = new double[3];
    for (int b = 0; b < 3; b++) {
      double db = raw[b + 1];
      env[b] = (float)Math.Max(db, env[b] - 1.2 * dt);
      if (env[b] < -75) env[b] = -75;
      double x = Math.Max(0, Math.Min(1, (db - (env[b] - 30)) / 30));
      lv[b] = Math.Pow(x, 1.5);
    }
    return lv;
  }

  static IBuddyAudioClient client;
  static IBuddyCaptureClient capture;
  static int channels, rate, bits; static bool isFloat;
  static string deviceId = "";

  static void Open() {
    Close();
    var en = (IBuddyDeviceEnumerator)(new BuddyMMDeviceEnumerator());
    IBuddyDevice dev;
    Marshal.ThrowExceptionForHR(en.GetDefaultAudioEndpoint(0, 1, out dev)); // eRender, eMultimedia
    dev.GetId(out deviceId);
    Guid iidClient = typeof(IBuddyAudioClient).GUID;
    object o;
    Marshal.ThrowExceptionForHR(dev.Activate(ref iidClient, 23, IntPtr.Zero, out o));
    client = (IBuddyAudioClient)o;
    IntPtr fmt;
    Marshal.ThrowExceptionForHR(client.GetMixFormat(out fmt));
    try {
      int tag = Marshal.ReadInt16(fmt, 0) & 0xffff;
      channels = Marshal.ReadInt16(fmt, 2);
      rate = Marshal.ReadInt32(fmt, 4);
      bits = Marshal.ReadInt16(fmt, 14);
      isFloat = tag == 3;
      if (tag == 0xFFFE) {
        var sub = (Guid)Marshal.PtrToStructure(new IntPtr(fmt.ToInt64() + 24), typeof(Guid));
        isFloat = sub == new Guid("00000003-0000-0010-8000-00aa00389b71");
      }
      Marshal.ThrowExceptionForHR(client.Initialize(0, LOOPBACK, 1000000, 0, fmt, IntPtr.Zero));
    } finally { Marshal.FreeCoTaskMem(fmt); }
    Guid iidCapture = typeof(IBuddyCaptureClient).GUID;
    object c;
    Marshal.ThrowExceptionForHR(client.GetService(ref iidCapture, out c));
    capture = (IBuddyCaptureClient)c;
    Marshal.ThrowExceptionForHR(client.Start());
    Console.Out.WriteLine("i," + rate + "," + channels + "," + bits + "," + (isFloat ? "f" : "i"));
    Console.Out.Flush();
  }

  static void Close() {
    try { if (client != null) client.Stop(); } catch { }
    if (capture != null) { try { Marshal.ReleaseComObject(capture); } catch { } }
    if (client != null) { try { Marshal.ReleaseComObject(client); } catch { } }
    capture = null; client = null;
  }

  static string CurrentDefaultId() {
    try {
      var en = (IBuddyDeviceEnumerator)(new BuddyMMDeviceEnumerator());
      IBuddyDevice dev;
      if (en.GetDefaultAudioEndpoint(0, 1, out dev) != 0) return "";
      string id; dev.GetId(out id);
      Marshal.ReleaseComObject(dev); Marshal.ReleaseComObject(en);
      return id ?? "";
    } catch { return ""; }
  }

  static float[] fbuf = new float[0];
  static short[] sbuf = new short[0];
  static int[] ibuf = new int[0];

  static void Read() {
    uint packet;
    for (;;) {
      int hr = capture.GetNextPacketSize(out packet);
      if (hr < 0) Marshal.ThrowExceptionForHR(hr);   // z. B. Gerät entfernt: neu verbinden
      if (packet == 0) break;
      IntPtr data; uint frames, flags; ulong p1, p2;
      Marshal.ThrowExceptionForHR(capture.GetBuffer(out data, out frames, out flags, out p1, out p2));
      int n = (int)frames * channels;
      bool silent = (flags & SILENT) != 0;
      if (!silent) {
        if (isFloat) { if (fbuf.Length < n) fbuf = new float[n]; Marshal.Copy(data, fbuf, 0, n); }
        else if (bits == 16) { if (sbuf.Length < n) sbuf = new short[n]; Marshal.Copy(data, sbuf, 0, n); }
        else if (bits == 32) { if (ibuf.Length < n) ibuf = new int[n]; Marshal.Copy(data, ibuf, 0, n); }
        else silent = true;   // ungewöhnliches Format (z. B. 24 Bit gepackt): lieber nichts anzeigen
      }
      capture.ReleaseBuffer(frames);
      for (int f = 0; f < (int)frames; f++) {
        float sum = 0;
        if (!silent) {
          int b0 = f * channels;
          for (int ch = 0; ch < channels; ch++) {
            if (isFloat) sum += fbuf[b0 + ch];
            else if (bits == 16) sum += sbuf[b0 + ch] / 32768f;
            else sum += ibuf[b0 + ch] / 2147483648f;
          }
        }
        ring[ringPos] = sum / channels;
        ringPos = (ringPos + 1) % ring.Length;
      }
      if (!silent) lastData = clock.Elapsed.TotalSeconds;
    }
  }

  static readonly Stopwatch clock = Stopwatch.StartNew();
  static double lastData = -10;

  public static void Run() {
    var inv = CultureInfo.InvariantCulture;
    var mono = new float[N];
    double lastFrame = 0, lastSilent = 0, lastCheck = 0;
    int errors = 0;
    for (;;) {
      try {
        if (client == null) { Open(); errors = 0; }
        Read();
        double now = clock.Elapsed.TotalSeconds;
        // Ausgabegerät gewechselt: neu verbinden
        if (now - lastCheck > 1.0) {
          lastCheck = now;
          string id = CurrentDefaultId();
          if (id != "" && id != deviceId) { Close(); continue; }
        }
        bool active = now - lastData < 0.25;
        if (active && now - lastFrame >= 1.0 / 60) {
          double dt = lastFrame > 0 ? Math.Min(0.1, now - lastFrame) : 1.0 / 60;
          lastFrame = now;
          int start = (ringPos - N + ring.Length) % ring.Length;
          for (int i = 0; i < N; i++) mono[i] = ring[(start + i) % ring.Length];
          var raw = Bands(mono, rate);
          if (raw[0] < 0.0005) { lastData = -10; continue; }   // digitale Stille (z. B. pausiert, Stream noch offen)
          var lv = Normalize(raw, dt);
          // Schlag: Bass springt deutlich über seinen kurzen Mittelwert
          int beat = 0;
          if (lv[0] - bassAvg > 0.22 && now - lastBeat > 0.25 && raw[0] > 0.01) { beat = 1; lastBeat = now; }
          bassAvg += (float)((lv[0] - bassAvg) * Math.Min(1, dt * 4));
          Console.Out.WriteLine("f," + raw[0].ToString("0.0000", inv) + "," + lv[0].ToString("0.000", inv) + "," + lv[1].ToString("0.000", inv) + "," + lv[2].ToString("0.000", inv) + "," + beat);
          Console.Out.Flush();
        } else if (!active && now - lastSilent > 0.25) {
          lastSilent = now;
          Console.Out.WriteLine("s");
          Console.Out.Flush();
        }
        System.Threading.Thread.Sleep(active ? 5 : 20);
      } catch (Exception ex) {
        Console.Out.WriteLine("e," + ex.Message.Replace("\n", " ").Replace(",", ";"));
        Console.Out.Flush();
        Close();
        System.Threading.Thread.Sleep(errors < 5 ? 1000 : 5000);
        errors++;
      }
    }
  }
}
`;

const ANALYZER_SCRIPT = `$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @"
${ANALYZER_CS}
"@
[Console]::Out.WriteLine('READY')
[Console]::Out.Flush()
[BuddyAudio]::Run()
`;

/**
 * Entscheidet aus dem echten Signal, ob gerade Musik klingt.
 * Aktiv: hörbarer Pegel über drei Bilder hinweg. Ruhig: 1,2 s ohne hörbaren Pegel.
 * @param {{ onChange: (active: boolean) => void, threshold?: number, holdMs?: number, now?: () => number }} opts
 */
function createActivity({ onChange, threshold = 0.004, holdMs = 1200, now = () => Date.now() }) {
  let active = false;
  let loudFrames = 0;
  let lastLoud = 0;
  return {
    /** @param {{ rms?: number, silent?: boolean }} frame */
    feed(frame) {
      const t = now();
      if (!frame.silent && (frame.rms || 0) >= threshold) {
        loudFrames += 1;
        lastLoud = t;
        if (!active && loudFrames >= 3) { active = true; onChange(true); }
      } else {
        loudFrames = 0;
        if (active && t - lastLoud >= holdMs) { active = false; onChange(false); }
      }
    },
    reset() {
      loudFrames = 0;
      if (active) { active = false; onChange(false); }
    },
    get active() { return active; },
  };
}

/** Eine Zeile des Helfers in ein Bild übersetzen @param {string} line */
function parseLine(line) {
  if (line === 's') return { silent: true };
  if (line.startsWith('f,')) {
    const [, rms, bass, mid, treble, beat] = line.split(',');
    const n = (x) => Math.max(0, Math.min(1, Number(x) || 0));
    return { rms: Number(rms) || 0, bass: n(bass), mid: n(mid), treble: n(treble), beat: beat === '1' };
  }
  if (line.startsWith('i,')) {
    const [, rate, channels, bits, kind] = line.split(',');
    return { info: { rate: Number(rate), channels: Number(channels), bits: Number(bits), float: kind === 'f' } };
  }
  if (line.startsWith('e,')) return { error: line.slice(2) };
  return null;
}

/**
 * @param {{ scriptDir: string, fakeScript?: string|null, onFrame: (f: {rms: number, bass: number, mid: number, treble: number, beat: boolean}) => void, onActive?: (active: boolean) => void, log?: (m: string) => void }} opts
 */
function createAudioMeter({ scriptDir, onFrame, onActive = () => {}, log = () => {}, fakeScript = null }) {
  let proc = null;
  let buffer = '';
  let failures = 0;
  let lastError = '';
  const activity = createActivity({ onChange: (a) => onActive(a) });
  const supported = () => process.platform === 'win32' || Boolean(fakeScript);

  function start() {
    if (proc || failures >= 3 || !supported()) return false;
    try {
      let p;
      if (fakeScript) {
        p = spawn(process.execPath, [fakeScript], { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } });
      } else {
        const file = path.join(scriptDir, 'buddy-audio.ps1');
        fs.mkdirSync(scriptDir, { recursive: true });
        fs.writeFileSync(file, '\ufeff' + ANALYZER_SCRIPT, 'utf8');
        p = spawn('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', file], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
      }
      proc = p;
      p.stdout.setEncoding('utf8');
      p.stdout.on('data', (chunk) => {
        buffer += chunk;
        let nl;
        while ((nl = buffer.indexOf('\n')) !== -1) {
          const line = buffer.slice(0, nl).trim();
          buffer = buffer.slice(nl + 1);
          const f = parseLine(line);
          if (!f) continue;
          if (f.info) { log(`Audio-Analyse: ${f.info.rate} Hz, ${f.info.channels} Kanäle`); failures = 0; continue; }
          if (f.error) {
            // Gleiche Meldung nicht jede Sekunde wiederholen (z. B. kein Ausgabegerät)
            if (f.error !== lastError) log(`Audio-Analyse: ${f.error}`);
            lastError = f.error;
            continue;
          }
          activity.feed(f);
          if (!f.silent && activity.active) onFrame(/** @type {any} */ (f));
        }
      });
      let err = '';
      p.stderr.setEncoding('utf8');
      p.stderr.on('data', (d) => { err = (err + d).slice(-500); });
      p.on('exit', (code) => {
        if (proc === p) proc = null;
        activity.reset();
        if (code) {
          failures += 1; // nicht endlos neu starten
          log(`Audio-Analyse beendet (${code}): ${err.slice(-200)}`);
        }
      });
      return true;
    } catch (e) {
      failures += 1;
      log(`Audio-Analyse nicht verfügbar: ${/** @type {Error} */ (e).message}`);
      return false;
    }
  }

  function stop() {
    if (!proc) return;
    const p = proc;
    proc = null;
    buffer = '';
    try { p.kill(); } catch { /* schon weg */ }
    activity.reset();
  }

  return {
    start, stop,
    running: () => Boolean(proc),
    active: () => activity.active,
    available: () => supported() && failures < 3,
  };
}

module.exports = { createAudioMeter, createActivity, parseLine, ANALYZER_CS, ANALYZER_SCRIPT };
