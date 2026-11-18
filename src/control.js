// Ton und Fenster steuern (Windows): ein kleiner PowerShell-Helfer mit C# (über Add-Type, wie
// BuddyVosk in src/voice.js). Er startet beim ersten Gebrauch, bleibt kurz offen und beendet
// sich nach 3 Minuten ohne Auftrag.
//
//  - Ton: Windows Core Audio (MMDevice API). Gesamtlautstärke und Stumm, Lautstärke und Stumm
//    pro App (Audio-Sitzungen), Mikrofon stumm/an, Ausgabegeräte auflisten.
//    Dokumentiert: https://learn.microsoft.com/windows/win32/coreaudio/ (geprüft 16.11.2026)
//  - Ausgabegerät wechseln: über IPolicyConfig. Diese Schnittstelle ist NICHT dokumentiert, wird
//    aber seit Windows 7 von vielen Werkzeugen benutzt (z. B. SoundSwitch, EarTrumpet,
//    AudioDeviceCmdlets). Microsoft kann sie ohne Ankündigung ändern; dann meldet der Helfer
//    einen Fehler und Buddy öffnet stattdessen die Ton-Einstellungen.
//  - Fenster: EnumWindows, WM_CLOSE (sanft), ShowWindow, SetWindowPos, Arbeitsbereich des Bildschirms.
//  - Installierte Apps: Shell-Ordner «shell:AppsFolder» (wie das Startmenü).
//
// Protokoll: Auftrag als eine Zeile «id<TAB>befehl<TAB>arg1<TAB>arg2 …», Argumente Base64 (UTF-8).
// Antwort als eine Zeile «id<TAB>ok|err<TAB>Base64-Text». Der Text sind Zeilen mit Tab-getrennten
// Feldern. Keine JSON-Listen an oder von PowerShell (Windows PowerShell 5.1 packt Listen um).

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const IDLE_MS = 3 * 60 * 1000;
const CALL_MS = 15000;

const CONTROL_CS = String.raw`
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
using System.Runtime.InteropServices;
using System.Text;

[ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")] class BuddyCtlEnumeratorCls {}
[ComImport, Guid("870af99c-171d-4f9e-af0d-e63df40c2bc9")] class BuddyCtlPolicyConfigCls {}

[Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IBuddyCtlEnumerator {
  [PreserveSig] int EnumAudioEndpoints(int dataFlow, int stateMask, out IBuddyCtlCollection devices);
  [PreserveSig] int GetDefaultAudioEndpoint(int dataFlow, int role, out IBuddyCtlDevice device);
  [PreserveSig] int GetDevice([MarshalAs(UnmanagedType.LPWStr)] string id, out IBuddyCtlDevice device);
}

[Guid("0BD7A1BE-7A1A-44DB-8397-CC5392387B5E"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IBuddyCtlCollection {
  [PreserveSig] int GetCount(out uint count);
  [PreserveSig] int Item(uint index, out IBuddyCtlDevice device);
}

[Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IBuddyCtlDevice {
  [PreserveSig] int Activate(ref Guid iid, int clsCtx, IntPtr activationParams, [MarshalAs(UnmanagedType.IUnknown)] out object iface);
  [PreserveSig] int OpenPropertyStore(int access, out IBuddyCtlPropertyStore store);
  [PreserveSig] int GetId([MarshalAs(UnmanagedType.LPWStr)] out string id);
  [PreserveSig] int GetState(out int state);
}

[StructLayout(LayoutKind.Sequential)]
struct BuddyCtlPropKey { public Guid fmtid; public int pid; }

[StructLayout(LayoutKind.Sequential)]
struct BuddyCtlPropVariant { public ushort vt; public ushort r1; public ushort r2; public ushort r3; public IntPtr p; public IntPtr p2; }

[Guid("886d8eeb-8cf2-4446-8d02-cdba1dbdcf99"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IBuddyCtlPropertyStore {
  [PreserveSig] int GetCount(out int count);
  [PreserveSig] int GetAt(int index, out BuddyCtlPropKey key);
  [PreserveSig] int GetValue(ref BuddyCtlPropKey key, out BuddyCtlPropVariant value);
}

[Guid("5CDF2C82-841E-4546-9722-0CF74078229A"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IBuddyCtlEndpointVolume {
  [PreserveSig] int RegisterControlChangeNotify(IntPtr notify);
  [PreserveSig] int UnregisterControlChangeNotify(IntPtr notify);
  [PreserveSig] int GetChannelCount(out uint count);
  [PreserveSig] int SetMasterVolumeLevel(float levelDb, ref Guid context);
  [PreserveSig] int SetMasterVolumeLevelScalar(float level, ref Guid context);
  [PreserveSig] int GetMasterVolumeLevel(out float levelDb);
  [PreserveSig] int GetMasterVolumeLevelScalar(out float level);
  [PreserveSig] int SetChannelVolumeLevel(uint channel, float levelDb, ref Guid context);
  [PreserveSig] int SetChannelVolumeLevelScalar(uint channel, float level, ref Guid context);
  [PreserveSig] int GetChannelVolumeLevel(uint channel, out float levelDb);
  [PreserveSig] int GetChannelVolumeLevelScalar(uint channel, out float level);
  [PreserveSig] int SetMute([MarshalAs(UnmanagedType.Bool)] bool mute, ref Guid context);
  [PreserveSig] int GetMute([MarshalAs(UnmanagedType.Bool)] out bool mute);
}

// IAudioSessionManager2 (mit den Methoden von IAudioSessionManager davor)
[Guid("77AA99A0-1BD6-484F-8BC7-2C654C9A9B6F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IBuddyCtlSessionManager {
  [PreserveSig] int GetAudioSessionControl(IntPtr sessionGuid, int flags, out IntPtr control);
  [PreserveSig] int GetSimpleAudioVolume(IntPtr sessionGuid, int flags, out IntPtr volume);
  [PreserveSig] int GetSessionEnumerator(out IBuddyCtlSessionEnumerator sessions);
}

[Guid("E2F5BB11-0570-40CA-ACDD-3AA01277DEE8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IBuddyCtlSessionEnumerator {
  [PreserveSig] int GetCount(out int count);
  [PreserveSig] int GetSession(int index, out IBuddyCtlSession session);
}

// IAudioSessionControl2 (mit den Methoden von IAudioSessionControl davor)
[Guid("bfb7ff88-7239-4fc9-8fa2-07c950be9c6d"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IBuddyCtlSession {
  [PreserveSig] int GetState(out int state);
  [PreserveSig] int GetDisplayName([MarshalAs(UnmanagedType.LPWStr)] out string name);
  [PreserveSig] int SetDisplayName([MarshalAs(UnmanagedType.LPWStr)] string name, ref Guid context);
  [PreserveSig] int GetIconPath([MarshalAs(UnmanagedType.LPWStr)] out string path);
  [PreserveSig] int SetIconPath([MarshalAs(UnmanagedType.LPWStr)] string path, ref Guid context);
  [PreserveSig] int GetGroupingParam(out Guid param);
  [PreserveSig] int SetGroupingParam(ref Guid param, ref Guid context);
  [PreserveSig] int RegisterAudioSessionNotification(IntPtr client);
  [PreserveSig] int UnregisterAudioSessionNotification(IntPtr client);
  [PreserveSig] int GetSessionIdentifier([MarshalAs(UnmanagedType.LPWStr)] out string id);
  [PreserveSig] int GetSessionInstanceIdentifier([MarshalAs(UnmanagedType.LPWStr)] out string id);
  [PreserveSig] int GetProcessId(out uint pid);
  [PreserveSig] int IsSystemSoundsSession();
}

[Guid("87CE5498-68D6-44E5-9215-6DA47EF883D8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IBuddyCtlSimpleVolume {
  [PreserveSig] int SetMasterVolume(float level, ref Guid context);
  [PreserveSig] int GetMasterVolume(out float level);
  [PreserveSig] int SetMute([MarshalAs(UnmanagedType.Bool)] bool mute, ref Guid context);
  [PreserveSig] int GetMute([MarshalAs(UnmanagedType.Bool)] out bool mute);
}

// IPolicyConfig (undokumentiert, Windows 7 bis 11). Nur SetDefaultEndpoint wird benutzt,
// die Methoden davor stehen nur für die richtige Reihenfolge da.
[Guid("f8679f50-850a-41cf-9c72-430f290290c8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IBuddyCtlPolicyConfig {
  [PreserveSig] int GetMixFormat(IntPtr a, IntPtr b);
  [PreserveSig] int GetDeviceFormat(IntPtr a, int b, IntPtr c);
  [PreserveSig] int ResetDeviceFormat(IntPtr a);
  [PreserveSig] int SetDeviceFormat(IntPtr a, IntPtr b, IntPtr c);
  [PreserveSig] int GetProcessingPeriod(IntPtr a, int b, IntPtr c, IntPtr d);
  [PreserveSig] int SetProcessingPeriod(IntPtr a, IntPtr b);
  [PreserveSig] int GetShareMode(IntPtr a, IntPtr b);
  [PreserveSig] int SetShareMode(IntPtr a, IntPtr b);
  [PreserveSig] int GetPropertyValue(IntPtr a, IntPtr b, IntPtr c);
  [PreserveSig] int SetPropertyValue(IntPtr a, IntPtr b, IntPtr c);
  [PreserveSig] int SetDefaultEndpoint([MarshalAs(UnmanagedType.LPWStr)] string id, int role);
  [PreserveSig] int SetEndpointVisibility([MarshalAs(UnmanagedType.LPWStr)] string id, int visible);
}

public static class BuddyControl {
  const int CLSCTX_ALL = 23;
  static Guid Ctx = Guid.Empty;

  static string Clean(string s) {
    if (s == null) return "";
    var b = new StringBuilder(s.Length);
    foreach (char c in s) b.Append(c == '\t' || c == '\r' || c == '\n' ? ' ' : c);
    return b.ToString().Trim();
  }

  static string Pct(float v) { return ((int)Math.Round(v * 100)).ToString(CultureInfo.InvariantCulture); }

  static void Check(int hr, string what) {
    if (hr != 0) throw new Exception(what + " (0x" + hr.ToString("X8") + ")");
  }

  // ---------- Ton ----------

  static IBuddyCtlEnumerator Enumerator() { return (IBuddyCtlEnumerator)(new BuddyCtlEnumeratorCls()); }

  static string FriendlyName(IBuddyCtlDevice dev) {
    IBuddyCtlPropertyStore store;
    if (dev.OpenPropertyStore(0, out store) != 0 || store == null) return "";
    var key = new BuddyCtlPropKey();
    key.fmtid = new Guid("a45c254e-df1c-4efd-8020-67d146a850e0");
    key.pid = 14;
    BuddyCtlPropVariant v;
    if (store.GetValue(ref key, out v) != 0) return "";
    string name = (v.vt == 31 && v.p != IntPtr.Zero) ? Marshal.PtrToStringUni(v.p) : "";
    PropVariantClear(ref v);
    return Clean(name);
  }

  [DllImport("ole32.dll")] static extern int PropVariantClear(ref BuddyCtlPropVariant v);

  static string DeviceId(IBuddyCtlDevice dev) { string id; dev.GetId(out id); return id ?? ""; }

  static IBuddyCtlDevice DefaultDevice(int flow) {
    IBuddyCtlDevice dev;
    Check(Enumerator().GetDefaultAudioEndpoint(flow, 1, out dev), flow == 0 ? "Kein Ausgabegerät" : "Kein Mikrofon");
    return dev;
  }

  static T Activate<T>(IBuddyCtlDevice dev, string iid) {
    Guid g = new Guid(iid);
    object o;
    Check(dev.Activate(ref g, CLSCTX_ALL, IntPtr.Zero, out o), "Aktivieren fehlgeschlagen");
    return (T)o;
  }

  static IBuddyCtlEndpointVolume EndpointVolume(IBuddyCtlDevice dev) {
    return Activate<IBuddyCtlEndpointVolume>(dev, "5CDF2C82-841E-4546-9722-0CF74078229A");
  }

  // Zeilen: device<TAB>out|in<TAB>default 0/1<TAB>id<TAB>name
  public static string Devices() {
    var sb = new StringBuilder();
    var en = Enumerator();
    for (int flow = 0; flow <= 1; flow++) {
      string def = "";
      try { def = DeviceId(DefaultDevice(flow)); } catch { }
      IBuddyCtlCollection col;
      if (en.EnumAudioEndpoints(flow, 1, out col) != 0 || col == null) continue;
      uint n; col.GetCount(out n);
      for (uint i = 0; i < n; i++) {
        IBuddyCtlDevice dev;
        if (col.Item(i, out dev) != 0 || dev == null) continue;
        string id = DeviceId(dev);
        sb.Append("device\t").Append(flow == 0 ? "out" : "in").Append('\t').Append(id == def ? "1" : "0")
          .Append('\t').Append(Clean(id)).Append('\t').Append(FriendlyName(dev)).Append('\n');
      }
    }
    return sb.ToString();
  }

  // Zeilen: master<TAB>prozent<TAB>stumm, mic<TAB>prozent<TAB>stumm, app<TAB>pid<TAB>prozess<TAB>prozent<TAB>stumm<TAB>name
  public static string Status() {
    var sb = new StringBuilder();
    var outDev = DefaultDevice(0);
    var vol = EndpointVolume(outDev);
    float level; bool mute;
    vol.GetMasterVolumeLevelScalar(out level); vol.GetMute(out mute);
    sb.Append("master\t").Append(Pct(level)).Append('\t').Append(mute ? "1" : "0").Append('\t').Append(FriendlyName(outDev)).Append('\n');
    try {
      var inDev = DefaultDevice(1);
      var mic = EndpointVolume(inDev);
      mic.GetMasterVolumeLevelScalar(out level); mic.GetMute(out mute);
      sb.Append("mic\t").Append(Pct(level)).Append('\t').Append(mute ? "1" : "0").Append('\t').Append(FriendlyName(inDev)).Append('\n');
    } catch { }
    foreach (var s in Sessions()) {
      float l; bool m;
      s.Volume.GetMasterVolume(out l); s.Volume.GetMute(out m);
      sb.Append("app\t").Append(s.Pid.ToString(CultureInfo.InvariantCulture)).Append('\t').Append(s.Process).Append('\t')
        .Append(Pct(l)).Append('\t').Append(m ? "1" : "0").Append('\t').Append(s.Name).Append('\n');
    }
    return sb.ToString();
  }

  class SessionInfo { public uint Pid; public string Process; public string Name; public IBuddyCtlSimpleVolume Volume; }

  static List<SessionInfo> Sessions() {
    var list = new List<SessionInfo>();
    var mgr = Activate<IBuddyCtlSessionManager>(DefaultDevice(0), "77AA99A0-1BD6-484F-8BC7-2C654C9A9B6F");
    IBuddyCtlSessionEnumerator en;
    Check(mgr.GetSessionEnumerator(out en), "Audio-Sitzungen nicht lesbar");
    int n; en.GetCount(out n);
    for (int i = 0; i < n; i++) {
      IBuddyCtlSession s;
      if (en.GetSession(i, out s) != 0 || s == null) continue;
      if (s.IsSystemSoundsSession() == 0) continue;
      int state; s.GetState(out state);
      if (state == 2) continue; // abgelaufen
      uint pid; s.GetProcessId(out pid);
      if (pid == 0) continue;
      var info = new SessionInfo();
      info.Pid = pid;
      try { info.Process = Clean(Process.GetProcessById((int)pid).ProcessName); } catch { continue; }
      string dn; s.GetDisplayName(out dn);
      info.Name = Clean(dn);
      info.Volume = (IBuddyCtlSimpleVolume)s;
      list.Add(info);
    }
    return list;
  }

  // level: -1 = nicht ändern; mute: -1 nicht ändern, 0 aus, 1 an. Antwort: vorher und nachher
  public static string SetMaster(int level, int mute) {
    var vol = EndpointVolume(DefaultDevice(0));
    return Apply(vol, level, mute);
  }

  public static string SetMic(int level, int mute) {
    var vol = EndpointVolume(DefaultDevice(1));
    return Apply(vol, level, mute);
  }

  static string Apply(IBuddyCtlEndpointVolume vol, int level, int mute) {
    float before; bool mb;
    vol.GetMasterVolumeLevelScalar(out before); vol.GetMute(out mb);
    if (level >= 0) Check(vol.SetMasterVolumeLevelScalar(Math.Min(100, level) / 100f, ref Ctx), "Lautstärke nicht gesetzt");
    if (mute >= 0) Check(vol.SetMute(mute == 1, ref Ctx), "Stumm nicht gesetzt");
    float after; bool ma;
    vol.GetMasterVolumeLevelScalar(out after); vol.GetMute(out ma);
    return "set\t" + Pct(before) + "\t" + (mb ? "1" : "0") + "\t" + Pct(after) + "\t" + (ma ? "1" : "0") + "\n";
  }

  // Alle Sitzungen der angegebenen Prozess-IDs (Komma-Liste). Zeilen: app<TAB>pid<TAB>prozess<TAB>vorher<TAB>stumm vorher<TAB>nachher<TAB>stumm nachher
  public static string SetApp(string pids, int level, int mute) {
    var wanted = new HashSet<uint>();
    foreach (var p in pids.Split(',')) { uint x; if (uint.TryParse(p.Trim(), out x)) wanted.Add(x); }
    var sb = new StringBuilder();
    foreach (var s in Sessions()) {
      if (!wanted.Contains(s.Pid)) continue;
      float before; bool mb;
      s.Volume.GetMasterVolume(out before); s.Volume.GetMute(out mb);
      if (level >= 0) Check(s.Volume.SetMasterVolume(Math.Min(100, level) / 100f, ref Ctx), "Lautstärke nicht gesetzt");
      if (mute >= 0) Check(s.Volume.SetMute(mute == 1, ref Ctx), "Stumm nicht gesetzt");
      float after; bool ma;
      s.Volume.GetMasterVolume(out after); s.Volume.GetMute(out ma);
      sb.Append("app\t").Append(s.Pid.ToString(CultureInfo.InvariantCulture)).Append('\t').Append(s.Process).Append('\t')
        .Append(Pct(before)).Append('\t').Append(mb ? "1" : "0").Append('\t').Append(Pct(after)).Append('\t').Append(ma ? "1" : "0").Append('\n');
    }
    return sb.ToString();
  }

  // Standardgerät für alle drei Rollen setzen (Konsole, Multimedia, Kommunikation)
  public static string SetDefault(string id) {
    IBuddyCtlDevice dev;
    Check(Enumerator().GetDevice(id, out dev), "Gerät nicht gefunden");
    int state; dev.GetState(out state);
    if (state != 1) throw new Exception("Gerät ist nicht aktiv");
    var policy = (IBuddyCtlPolicyConfig)(new BuddyCtlPolicyConfigCls());
    for (int role = 0; role <= 2; role++) Check(policy.SetDefaultEndpoint(id, role), "Gerätewechsel abgelehnt");
    return "ok\t" + FriendlyName(dev) + "\n";
  }

  // ---------- Fenster ----------

  delegate bool EnumProc(IntPtr hwnd, IntPtr lParam);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc proc, IntPtr lParam);
  [DllImport("user32.dll")] static extern bool EnumDisplayMonitors(IntPtr hdc, IntPtr clip, MonitorProc proc, IntPtr data);
  delegate bool MonitorProc(IntPtr monitor, IntPtr hdc, IntPtr rect, IntPtr data);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr hwnd);
  [DllImport("user32.dll")] static extern bool IsWindow(IntPtr hwnd);
  [DllImport("user32.dll")] static extern bool IsIconic(IntPtr hwnd);
  [DllImport("user32.dll")] static extern bool IsZoomed(IntPtr hwnd);
  [DllImport("user32.dll")] static extern IntPtr GetWindow(IntPtr hwnd, uint cmd);
  [DllImport("user32.dll")] static extern int GetWindowLong(IntPtr hwnd, int index);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr hwnd, StringBuilder text, int max);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassName(IntPtr hwnd, StringBuilder text, int max);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid);
  [DllImport("user32.dll")] static extern bool PostMessage(IntPtr hwnd, uint msg, IntPtr w, IntPtr l);
  [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr hwnd, int cmd);
  [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr hwnd);
  [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] static extern bool BringWindowToTop(IntPtr hwnd);
  [DllImport("user32.dll")] static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr extra);
  [DllImport("user32.dll")] static extern bool SetWindowPos(IntPtr hwnd, IntPtr after, int x, int y, int w, int h, uint flags);
  [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr hwnd, out RECT rect);
  [DllImport("user32.dll")] static extern IntPtr MonitorFromWindow(IntPtr hwnd, uint flags);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern bool GetMonitorInfo(IntPtr monitor, ref MONITORINFO info);
  [DllImport("dwmapi.dll")] static extern int DwmGetWindowAttribute(IntPtr hwnd, int attr, out RECT value, int size);
  [DllImport("dwmapi.dll")] static extern int DwmGetWindowAttribute(IntPtr hwnd, int attr, out int value, int size);
  [DllImport("user32.dll")] static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] static extern bool SetProcessDpiAwarenessContext(IntPtr value);

  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  public struct MONITORINFO { public int cbSize; public RECT rcMonitor; public RECT rcWork; public int dwFlags; }

  static bool dpiSet = false;
  static void Dpi() {
    if (dpiSet) return;
    dpiSet = true;
    try { if (SetProcessDpiAwarenessContext(new IntPtr(-4))) return; } catch { }
    try { SetProcessDPIAware(); } catch { }
  }

  static string Text(IntPtr hwnd) { var sb = new StringBuilder(512); GetWindowText(hwnd, sb, 512); return Clean(sb.ToString()); }
  static string Class(IntPtr hwnd) { var sb = new StringBuilder(256); GetClassName(hwnd, sb, 256); return Clean(sb.ToString()); }

  static bool IsAppWindow(IntPtr hwnd) {
    if (!IsWindowVisible(hwnd)) return false;
    if (GetWindow(hwnd, 4) != IntPtr.Zero) return false; // hat Besitzer (Dialog)
    int ex = GetWindowLong(hwnd, -20);
    if ((ex & 0x80) != 0) return false; // Werkzeugfenster
    int cloaked = 0;
    try { DwmGetWindowAttribute(hwnd, 14, out cloaked, 4); } catch { }
    if (cloaked != 0) return false; // versteckt (andere Desktops, angehaltene Apps)
    return Text(hwnd).Length > 0;
  }

  // Zeilen: win<TAB>hwnd<TAB>pid<TAB>prozess<TAB>klasse<TAB>zustand (min/max/normal)<TAB>vorne 0/1<TAB>titel
  public static string Windows() {
    Dpi();
    var sb = new StringBuilder();
    IntPtr fg = GetForegroundWindow();
    var names = new Dictionary<uint, string>();
    EnumWindows(delegate (IntPtr hwnd, IntPtr l) {
      if (!IsAppWindow(hwnd)) return true;
      uint pid; GetWindowThreadProcessId(hwnd, out pid);
      string name;
      if (!names.TryGetValue(pid, out name)) {
        try { name = Clean(Process.GetProcessById((int)pid).ProcessName); } catch { name = ""; }
        names[pid] = name;
      }
      string state = IsIconic(hwnd) ? "min" : IsZoomed(hwnd) ? "max" : "normal";
      sb.Append("win\t").Append(hwnd.ToInt64().ToString(CultureInfo.InvariantCulture)).Append('\t')
        .Append(pid.ToString(CultureInfo.InvariantCulture)).Append('\t').Append(name).Append('\t').Append(Class(hwnd)).Append('\t')
        .Append(state).Append('\t').Append(hwnd == fg ? "1" : "0").Append('\t').Append(Text(hwnd)).Append('\n');
      return true;
    }, IntPtr.Zero);
    return sb.ToString();
  }

  static IntPtr Handle(string h) {
    long v;
    if (!long.TryParse(h, NumberStyles.Integer, CultureInfo.InvariantCulture, out v)) throw new Exception("Ungültiges Fenster");
    var hwnd = new IntPtr(v);
    if (!IsWindow(hwnd)) throw new Exception("Fenster gibt es nicht mehr");
    return hwnd;
  }

  // Sanft schliessen (wie ein Klick aufs X). Wartet bis zu 3 s. Antwort: closed oder open
  public static string Close(string h) {
    var hwnd = Handle(h);
    PostMessage(hwnd, 0x0010, IntPtr.Zero, IntPtr.Zero);
    for (int i = 0; i < 30; i++) {
      System.Threading.Thread.Sleep(100);
      if (!IsWindow(hwnd) || !IsWindowVisible(hwnd)) return "closed\n";
    }
    return "open\n";
  }

  // Hart beenden (nur nach Freigabe, Prüfung im Hauptprozess)
  public static string Kill(string pidText) {
    int pid;
    if (!int.TryParse(pidText, out pid) || pid <= 4) throw new Exception("Ungültiger Prozess");
    var p = Process.GetProcessById(pid);
    p.Kill();
    p.WaitForExit(3000);
    return (p.HasExited ? "killed" : "running") + "\n";
  }

  public static string Focus(string h) {
    var hwnd = Handle(h);
    if (IsIconic(hwnd)) ShowWindow(hwnd, 9);
    SetForegroundWindow(hwnd);
    if (GetForegroundWindow() != hwnd) {
      // Windows erlaubt den Wechsel nur nach einer Eingabe: kurz Alt drücken und loslassen
      keybd_event(0x12, 0, 0, UIntPtr.Zero);
      keybd_event(0x12, 0, 2, UIntPtr.Zero);
      SetForegroundWindow(hwnd);
      BringWindowToTop(hwnd);
    }
    return (GetForegroundWindow() == hwnd ? "front" : "behind") + "\n";
  }

  public static string Show(string h, int cmd) {
    var hwnd = Handle(h);
    ShowWindow(hwnd, cmd);
    return (IsIconic(hwnd) ? "min" : IsZoomed(hwnd) ? "max" : "normal") + "\n";
  }

  static RECT Work(IntPtr monitor) {
    var info = new MONITORINFO();
    info.cbSize = Marshal.SizeOf(typeof(MONITORINFO));
    GetMonitorInfo(monitor, ref info);
    return info.rcWork;
  }

  // Unsichtbarer Rand (Windows 10/11): Unterschied zwischen Fensterrechteck und sichtbarem Rahmen
  static RECT Border(IntPtr hwnd) {
    RECT win, vis, d = new RECT();
    if (!GetWindowRect(hwnd, out win)) return d;
    if (DwmGetWindowAttribute(hwnd, 9, out vis, Marshal.SizeOf(typeof(RECT))) != 0) return d;
    d.Left = vis.Left - win.Left; d.Top = vis.Top - win.Top; d.Right = win.Right - vis.Right; d.Bottom = win.Bottom - vis.Bottom;
    return d;
  }

  static void Place(IntPtr hwnd, int x, int y, int w, int h) {
    if (IsIconic(hwnd) || IsZoomed(hwnd)) ShowWindow(hwnd, 9);
    var b = Border(hwnd);
    SetWindowPos(hwnd, IntPtr.Zero, x - b.Left, y - b.Top, w + b.Left + b.Right, h + b.Top + b.Bottom, 0x0014);
  }

  // mode: left, right, center, move (x,y,w,h in Prozent des Arbeitsbereichs), next (nächster Bildschirm)
  public static string Move(string h, string mode, int px, int py, int pw, int ph) {
    Dpi();
    var hwnd = Handle(h);
    var mon = MonitorFromWindow(hwnd, 2);
    var r = Work(mon);
    int W = r.Right - r.Left, H = r.Bottom - r.Top;
    if (mode == "left") Place(hwnd, r.Left, r.Top, W / 2, H);
    else if (mode == "right") Place(hwnd, r.Left + W - W / 2, r.Top, W / 2, H);
    else if (mode == "center") {
      int w = W * 2 / 3, hh = H * 3 / 4;
      Place(hwnd, r.Left + (W - w) / 2, r.Top + (H - hh) / 2, w, hh);
    } else if (mode == "move") {
      int w = Math.Max(240, W * pw / 100), hh = Math.Max(160, H * ph / 100);
      Place(hwnd, r.Left + W * px / 100, r.Top + H * py / 100, Math.Min(w, W), Math.Min(hh, H));
    } else if (mode == "next") {
      var mons = new List<IntPtr>();
      EnumDisplayMonitors(IntPtr.Zero, IntPtr.Zero, delegate (IntPtr m, IntPtr dc, IntPtr rc, IntPtr d) { mons.Add(m); return true; }, IntPtr.Zero);
      if (mons.Count < 2) return "single\n";
      int i = mons.IndexOf(mon);
      var t = Work(mons[(i + 1) % mons.Count]);
      bool max = IsZoomed(hwnd);
      RECT cur; GetWindowRect(hwnd, out cur);
      if (max) ShowWindow(hwnd, 9);
      GetWindowRect(hwnd, out cur);
      int TW = t.Right - t.Left, TH = t.Bottom - t.Top;
      int w = Math.Min(cur.Right - cur.Left, TW), hh = Math.Min(cur.Bottom - cur.Top, TH);
      int x = t.Left + (int)((long)(cur.Left - r.Left) * TW / Math.Max(1, W));
      int y = t.Top + (int)((long)(cur.Top - r.Top) * TH / Math.Max(1, H));
      x = Math.Max(t.Left, Math.Min(x, t.Right - w)); y = Math.Max(t.Top, Math.Min(y, t.Bottom - hh));
      SetWindowPos(hwnd, IntPtr.Zero, x, y, w, hh, 0x0014);
      if (max) ShowWindow(hwnd, 3);
    } else throw new Exception("Unbekannte Anordnung");
    return "ok\n";
  }
}
`;

const SCRIPT = String.raw`
param([string]$cs = '')
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
Add-Type -TypeDefinition ([System.IO.File]::ReadAllText($cs, [System.Text.Encoding]::UTF8)) -Language CSharp
function Dec($s) { return [System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($s)) }
function Enc($s) { return [Convert]::ToBase64String([System.Text.Encoding]::UTF8.GetBytes([string]$s)) }
function Num($s) { $n = 0; if ([int]::TryParse((Dec $s), [ref]$n)) { return $n } return -1 }

function InstalledApps {
  $sb = New-Object System.Text.StringBuilder
  $folder = (New-Object -ComObject Shell.Application).NameSpace('shell:AppsFolder')
  foreach ($item in $folder.Items()) {
    $name = ([string]$item.Name) -replace '[\t\r\n]', ' '
    $id = ([string]$item.Path) -replace '[\t\r\n]', ' '
    if ($name -and $id) { [void]$sb.Append('installed').Append([char]9).Append($id).Append([char]9).Append($name).Append([char]10) }
  }
  return $sb.ToString()
}

[Console]::Out.WriteLine('ready')
[Console]::Out.Flush()
$stdin = New-Object System.IO.StreamReader([Console]::OpenStandardInput())
while ($true) {
  $line = $stdin.ReadLine()
  if ($line -eq $null -or $line -eq 'quit') { break }
  $parts = $line.Split([char]9)
  $id = $parts[0]
  $a = @($parts | Select-Object -Skip 2)
  $status = 'ok'
  try {
    switch ($parts[1]) {
      'devices'   { $out = [BuddyControl]::Devices() }
      'status'    { $out = [BuddyControl]::Status() }
      'master'    { $out = [BuddyControl]::SetMaster((Num $a[0]), (Num $a[1])) }
      'mic'       { $out = [BuddyControl]::SetMic((Num $a[0]), (Num $a[1])) }
      'app'       { $out = [BuddyControl]::SetApp((Dec $a[0]), (Num $a[1]), (Num $a[2])) }
      'default'   { $out = [BuddyControl]::SetDefault((Dec $a[0])) }
      'windows'   { $out = [BuddyControl]::Windows() }
      'installed' { $out = InstalledApps }
      'close'     { $out = [BuddyControl]::Close((Dec $a[0])) }
      'kill'      { $out = [BuddyControl]::Kill((Dec $a[0])) }
      'focus'     { $out = [BuddyControl]::Focus((Dec $a[0])) }
      'show'      { $out = [BuddyControl]::Show((Dec $a[0]), (Num $a[1])) }
      'move'      { $out = [BuddyControl]::Move((Dec $a[0]), (Dec $a[1]), (Num $a[2]), (Num $a[3]), (Num $a[4]), (Num $a[5])) }
      default     { throw 'Unbekannter Befehl' }
    }
  } catch {
    $status = 'err'
    $out = $_.Exception.Message
  }
  [Console]::Out.WriteLine($id + [char]9 + $status + [char]9 + (Enc $out))
  [Console]::Out.Flush()
}
`;

const b64 = (x) => Buffer.from(String(x), 'utf8').toString('base64');

// Antwortzeile «id<TAB>ok|err<TAB>base64» lesen
function parseReply(line) {
  const [id, status, data = ''] = String(line).split('\t');
  if (!id || !status) return null;
  let text = '';
  try { text = Buffer.from(data, 'base64').toString('utf8'); } catch { text = ''; }
  return { id, ok: status === 'ok', text };
}

// Auftragszeile bauen (Argumente Base64, damit Tabs und Zeilenumbrüche nichts kaputt machen)
function encodeCommand(id, cmd, args = []) {
  return [id, cmd, ...args.map((a) => b64(a))].join('\t');
}

function createControl({ scriptDir, log, spawnFn = spawn, platform = process.platform } = {}) {
  let proc = null;
  let ready = null;
  let buffer = '';
  let counter = 0;
  let idleTimer = null;
  const pending = new Map();

  function failAll(message) {
    for (const [, p] of pending) { clearTimeout(p.timer); p.reject(new Error(message)); }
    pending.clear();
  }

  function start() {
    if (proc) return ready;
    const file = path.join(scriptDir, 'buddy-control.ps1');
    fs.mkdirSync(scriptDir, { recursive: true });
    const csFile = path.join(scriptDir, 'buddy-control.cs');
    fs.writeFileSync(file, '﻿' + SCRIPT, 'utf8');
    fs.writeFileSync(csFile, CONTROL_CS, 'utf8');
    const p = spawnFn('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', file, '-cs', csFile], {
      windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
    });
    proc = p;
    buffer = '';
    ready = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Der Steuer-Helfer startet nicht.')), 20000);
      p.stdout.setEncoding('utf8');
      p.stdout.on('data', (chunk) => {
        buffer += chunk;
        let nl;
        while ((nl = buffer.indexOf('\n')) !== -1) {
          const line = buffer.slice(0, nl).replace(/^﻿/, '').trim();
          buffer = buffer.slice(nl + 1);
          if (!line) continue;
          if (line === 'ready') { clearTimeout(timer); resolve(); continue; }
          const reply = parseReply(line);
          const job = reply && pending.get(reply.id);
          if (!job) continue;
          pending.delete(reply.id);
          clearTimeout(job.timer);
          if (reply.ok) job.resolve(reply.text);
          else job.reject(new Error(reply.text || 'Fehler im Steuer-Helfer'));
        }
      });
      let errText = '';
      p.stderr?.setEncoding?.('utf8');
      p.stderr?.on('data', (d) => { errText = (errText + d).slice(-2000); });
      p.on('exit', () => {
        clearTimeout(timer);
        if (proc === p) { proc = null; ready = null; }
        if (errText.trim()) log?.(`Steuer-Helfer: ${errText.trim().slice(-400)}`);
        reject(new Error('Der Steuer-Helfer wurde beendet.'));
        failAll('Der Steuer-Helfer wurde beendet.');
      });
      p.on('error', (err) => {
        clearTimeout(timer);
        if (proc === p) { proc = null; ready = null; }
        reject(err);
        failAll(err.message);
      });
    });
    ready.catch(() => {});
    return ready;
  }

  function touch() {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(stop, IDLE_MS);
    idleTimer.unref?.();
  }

  async function call(cmd, ...args) {
    if (platform !== 'win32') throw new Error('Das geht nur unter Windows.');
    await start();
    touch();
    const id = `c${++counter}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { pending.delete(id); reject(new Error('Der Steuer-Helfer antwortet nicht.')); }, CALL_MS);
      pending.set(id, { resolve, reject, timer });
      try { proc.stdin.write(encodeCommand(id, cmd, args) + '\n'); } catch (err) { pending.delete(id); clearTimeout(timer); reject(err); }
    });
  }

  function stop() {
    clearTimeout(idleTimer);
    if (!proc) return;
    const p = proc;
    proc = null;
    ready = null;
    try { p.stdin.write('quit\n'); } catch { /* weg */ }
    setTimeout(() => { try { p.kill(); } catch { /* weg */ } }, 1500).unref?.();
  }

  return { call, stop, running: () => Boolean(proc) };
}

module.exports = { createControl, parseReply, encodeCommand, CONTROL_CS, SCRIPT };
