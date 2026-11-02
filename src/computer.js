// PC-Steuerung für Buddy: Bildschirmfotos, Maus und Tastatur.
//
// - Bildschirmfotos kommen von Electrons desktopCapturer.
// - Maus & Tastatur laufen über einen kleinen PowerShell-Helfer, der die
//   Windows-Funktion SendInput aufruft (keine zusätzlichen Programme nötig).
// - Der Helfer startet erst, wenn Buddy wirklich steuern darf, und beendet
//   sich nach 2 Minuten ohne Aktion wieder (spart CPU und RAM).

const { desktopCapturer, screen } = require('electron');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const SHOT_LONG_EDGE = 1366; // gute Balance aus Lesbarkeit, Tempo und Kosten
const HELPER_IDLE_MS = 2 * 60 * 1000;
const MAX_WAIT_S = 30;

// ---------- PowerShell-Helfer ----------

const HELPER_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Threading;

public static class BuddyInput {
  [StructLayout(LayoutKind.Sequential)] public struct MOUSEINPUT { public int dx; public int dy; public uint mouseData; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }
  [StructLayout(LayoutKind.Sequential)] public struct KEYBDINPUT { public ushort wVk; public ushort wScan; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }
  [StructLayout(LayoutKind.Sequential)] public struct HARDWAREINPUT { public uint uMsg; public ushort wParamL; public ushort wParamH; }
  [StructLayout(LayoutKind.Explicit)] public struct InputUnion { [FieldOffset(0)] public MOUSEINPUT mi; [FieldOffset(0)] public KEYBDINPUT ki; [FieldOffset(0)] public HARDWAREINPUT hi; }
  [StructLayout(LayoutKind.Sequential)] public struct INPUT { public uint type; public InputUnion U; }
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X; public int Y; }

  [DllImport("user32.dll", SetLastError = true)] static extern uint SendInput(uint n, INPUT[] inputs, int size);
  [DllImport("user32.dll")] static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] static extern bool GetCursorPos(out POINT p);
  [DllImport("user32.dll")] static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] static extern bool SetProcessDpiAwarenessContext(IntPtr value);
  [DllImport("user32.dll")] static extern short VkKeyScan(char ch);
  [DllImport("user32.dll")] static extern uint MapVirtualKey(uint code, uint mapType);

  public static void InitDpi() {
    try { if (SetProcessDpiAwarenessContext(new IntPtr(-4))) return; } catch { }
    try { SetProcessDPIAware(); } catch { }
  }

  static void Send(INPUT[] inputs) {
    uint sent = SendInput((uint)inputs.Length, inputs, Marshal.SizeOf(typeof(INPUT)));
    if (sent != inputs.Length) throw new Exception("Windows hat die Eingabe blockiert (" + Marshal.GetLastWin32Error() + ")");
  }

  static INPUT Mouse(uint flags, int data) {
    INPUT i = new INPUT();
    i.type = 0;
    i.U.mi.dwFlags = flags;
    i.U.mi.mouseData = unchecked((uint)data);
    return i;
  }

  static INPUT Kb(ushort vk, ushort scan, uint flags) {
    INPUT i = new INPUT();
    i.type = 1;
    i.U.ki.wVk = vk;
    i.U.ki.wScan = scan;
    i.U.ki.dwFlags = flags;
    return i;
  }

  static uint DownFlag(string b) { return b == "right" ? 0x0008u : b == "middle" ? 0x0020u : 0x0002u; }
  static uint UpFlag(string b) { return b == "right" ? 0x0010u : b == "middle" ? 0x0040u : 0x0004u; }

  public static void Move(int x, int y) { SetCursorPos(x, y); }

  public static void Button(string b, bool down) {
    Send(new INPUT[] { Mouse(down ? DownFlag(b) : UpFlag(b), 0) });
  }

  public static void Click(string b, int count) {
    for (int n = 0; n < count; n++) {
      Send(new INPUT[] { Mouse(DownFlag(b), 0), Mouse(UpFlag(b), 0) });
      if (n < count - 1) Thread.Sleep(70);
    }
  }

  public static void Scroll(int dx, int dy) {
    int steps = Math.Max(Math.Abs(dx), Math.Abs(dy));
    for (int n = 0; n < steps; n++) {
      if (n < Math.Abs(dy)) Send(new INPUT[] { Mouse(0x0800, dy > 0 ? 120 : -120) });
      if (n < Math.Abs(dx)) Send(new INPUT[] { Mouse(0x1000, dx > 0 ? 120 : -120) });
      Thread.Sleep(15);
    }
  }

  public static void Key(int vk, bool extended, bool up) {
    uint flags = (extended ? 0x0001u : 0u) | (up ? 0x0002u : 0u);
    ushort scan = (ushort)MapVirtualKey((uint)vk, 0);
    Send(new INPUT[] { Kb((ushort)vk, scan, flags) });
  }

  public static void KeyChar(string s, bool up) {
    char ch = s[0];
    short r = VkKeyScan(ch);
    if (r == -1) {
      Send(new INPUT[] { Kb(0, ch, 0x0004u | (up ? 0x0002u : 0u)) });
      return;
    }
    Key(r & 0xff, false, up);
  }

  public static void Type(string text) {
    foreach (char ch in text) {
      if (ch == '\r') continue;
      if (ch == '\n') { Key(0x0D, false, false); Key(0x0D, false, true); }
      else if (ch == '\t') { Key(0x09, false, false); Key(0x09, false, true); }
      else Send(new INPUT[] { Kb(0, ch, 0x0004), Kb(0, ch, 0x0004 | 0x0002) });
      Thread.Sleep(4);
    }
  }

  public static string Pos() {
    POINT p;
    GetCursorPos(out p);
    return p.X + "," + p.Y;
  }
}
'@
[BuddyInput]::InitDpi()
[Console]::Out.WriteLine('READY')
[Console]::Out.Flush()
while ($true) {
  $line = [Console]::In.ReadLine()
  if ($line -eq $null) { break }
  $result = ''
  try {
    $c = $line | ConvertFrom-Json
    switch ($c.op) {
      'move'    { [BuddyInput]::Move([int]$c.x, [int]$c.y) }
      'button'  { [BuddyInput]::Button([string]$c.btn, [bool]$c.down) }
      'click'   { [BuddyInput]::Click([string]$c.btn, [int]$c.count) }
      'scroll'  { [BuddyInput]::Scroll([int]$c.dx, [int]$c.dy) }
      'key'     { [BuddyInput]::Key([int]$c.vk, [bool]$c.ext, [bool]$c.up) }
      'keychar' { [BuddyInput]::KeyChar([System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($c.b64)), [bool]$c.up) }
      'type'    { [BuddyInput]::Type([System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($c.b64))) }
      'pos'     { $result = [BuddyInput]::Pos() }
      'ping'    { $result = 'pong' }
    }
    [Console]::Out.WriteLine('OK ' + $result)
  } catch {
    [Console]::Out.WriteLine('ERR ' + ($_.Exception.Message -replace '\s+', ' '))
  }
  [Console]::Out.Flush()
}
`;

class InputHelper {
  constructor(scriptDir) {
    this.scriptDir = scriptDir;
    this.proc = null;
    this.ready = null;
    this.queue = [];
    this.buffer = '';
    this.idleTimer = null;
    this.fake = process.env.BUDDY_FAKE_INPUT ? [] : null; // nur für Tests
  }

  start() {
    if (this.fake) return Promise.resolve();
    if (this.ready) return this.ready;
    if (process.platform !== 'win32') return Promise.reject(new Error('PC-Steuerung gibt es nur unter Windows.'));

    const file = path.join(this.scriptDir, 'buddy-input.ps1');
    fs.mkdirSync(this.scriptDir, { recursive: true });
    fs.writeFileSync(file, '﻿' + HELPER_SCRIPT, 'utf8');

    this.ready = new Promise((resolve, reject) => {
      const proc = spawn('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', file], {
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      this.proc = proc;
      let started = false;
      const fail = (err) => {
        this.stop();
        if (!started) reject(err);
      };
      proc.on('error', fail);
      proc.on('exit', () => {
        const err = new Error('Der Steuerungs-Helfer wurde beendet.');
        this.queue.splice(0).forEach((p) => p.reject(err));
        if (this.proc === proc) {
          this.proc = null;
          this.ready = null;
        }
        if (!started) reject(err);
      });
      proc.stdout.setEncoding('utf8');
      proc.stdout.on('data', (chunk) => {
        this.buffer += chunk;
        let nl;
        while ((nl = this.buffer.indexOf('\n')) !== -1) {
          const line = this.buffer.slice(0, nl).trim();
          this.buffer = this.buffer.slice(nl + 1);
          if (!started) {
            if (line === 'READY') { started = true; resolve(); }
            continue;
          }
          const pending = this.queue.shift();
          if (!pending) continue;
          if (line.startsWith('OK')) pending.resolve(line.slice(3));
          else pending.reject(new Error(line.slice(4) || 'Unbekannter Fehler'));
        }
      });
      let errText = '';
      proc.stderr.setEncoding('utf8');
      proc.stderr.on('data', (d) => { errText += d; });
      setTimeout(() => { if (!started) fail(new Error('Der Steuerungs-Helfer startet nicht. ' + errText.slice(0, 200))); }, 20000);
    });
    return this.ready;
  }

  async send(cmd) {
    if (this.fake) {
      this.fake.push(cmd);
      return cmd.op === 'pos' ? '100,100' : '';
    }
    await this.start();
    this.touch();
    return new Promise((resolve, reject) => {
      this.queue.push({ resolve, reject });
      this.proc.stdin.write(JSON.stringify(cmd) + '\n');
    });
  }

  touch() {
    clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => this.stop(), HELPER_IDLE_MS);
  }

  stop() {
    clearTimeout(this.idleTimer);
    if (this.proc) {
      try { this.proc.stdin.end(); } catch { /* schon zu */ }
      try { this.proc.kill(); } catch { /* schon weg */ }
    }
    this.proc = null;
    this.ready = null;
  }
}

// ---------- Tastennamen -> Windows Virtual-Key-Codes ----------

const VK = {
  backspace: 0x08, tab: 0x09, return: 0x0d, enter: 0x0d, kp_enter: 0x0d,
  escape: 0x1b, esc: 0x1b, space: 0x20, pause: 0x13, print: 0x2c, sys_req: 0x2c,
  caps_lock: 0x14, num_lock: 0x90, scroll_lock: 0x91, menu: 0x5d, apps: 0x5d,
  shift: 0xa0, shift_l: 0xa0, shift_r: 0xa1,
  ctrl: 0xa2, control: 0xa2, control_l: 0xa2, ctrl_l: 0xa2,
  alt: 0xa4, alt_l: 0xa4, option: 0xa4,
  super: 0x5b, super_l: 0x5b, super_r: 0x5c, win: 0x5b, windows: 0x5b, cmd: 0x5b, command: 0x5b, meta: 0x5b, meta_l: 0x5b,
  minus: 0xbd, equal: 0xbb, comma: 0xbc, period: 0xbe, slash: 0xbf, semicolon: 0xba,
  apostrophe: 0xde, bracketleft: 0xdb, bracketright: 0xdd, backslash: 0xdc, grave: 0xc0,
  plus: 0x6b, kp_add: 0x6b, kp_subtract: 0x6d, kp_multiply: 0x6a, kp_divide: 0x6f, kp_decimal: 0x6e,
  xf86audioraisevolume: 0xaf, xf86audiolowervolume: 0xae, xf86audiomute: 0xad,
  xf86audioplay: 0xb3, xf86audiopause: 0xb3, xf86audionext: 0xb0, xf86audioprev: 0xb1, xf86audiostop: 0xb2,
};
// Diese Tasten brauchen das "extended"-Flag
const EXT = {
  right: 0x27, left: 0x25, up: 0x26, down: 0x28,
  home: 0x24, end: 0x23, prior: 0x21, page_up: 0x21, pageup: 0x21, next: 0x22, page_down: 0x22, pagedown: 0x22,
  insert: 0x2d, delete: 0x2e, del: 0x2e, control_r: 0xa3, ctrl_r: 0xa3, alt_r: 0xa5, altgr: 0xa5,
};

function resolveKey(name) {
  const raw = String(name).trim();
  const key = raw.toLowerCase();
  if (key in VK) return { vk: VK[key], ext: false };
  if (key in EXT) return { vk: EXT[key], ext: true };
  let m;
  if ((m = key.match(/^f([1-9]|1\d|2[0-4])$/))) return { vk: 0x6f + Number(m[1]), ext: false };
  if ((m = key.match(/^kp_(\d)$/))) return { vk: 0x60 + Number(m[1]), ext: false };
  if (/^[a-z]$/.test(key)) return { vk: key.toUpperCase().charCodeAt(0), ext: false };
  if (/^\d$/.test(key)) return { vk: key.charCodeAt(0), ext: false };
  if ([...raw].length === 1) return { char: raw };
  throw new Error(`Unbekannte Taste: ${raw}`);
}

function parseCombo(text) {
  // "ctrl+shift+t" -> Tasten. Ein einzelnes "+" ist die Plus-Taste.
  const parts = String(text).trim() === '+' ? ['plus'] : String(text).split('+').map((p) => p.trim()).filter(Boolean);
  if (!parts.length) throw new Error('Keine Taste angegeben.');
  return parts.map(resolveKey);
}

const b64 = (text) => Buffer.from(String(text), 'utf8').toString('base64');
const sleep = (ms, signal) => new Promise((resolve, reject) => {
  const t = setTimeout(resolve, ms);
  signal?.addEventListener('abort', () => { clearTimeout(t); reject(Object.assign(new Error('abgebrochen'), { name: 'AbortError' })); }, { once: true });
});

// ---------- Steuerung ----------

function createComputer({ scriptDir, onPointer, beforeInput, afterInput, beforeCapture, afterCapture }) {
  const helper = new InputHelper(scriptDir);
  let shot = null; // { w, h } Grösse des letzten Bildschirmfotos

  function display() {
    const d = screen.getPrimaryDisplay();
    return {
      d,
      physW: Math.round(d.size.width * d.scaleFactor),
      physH: Math.round(d.size.height * d.scaleFactor),
    };
  }

  function shotSize() {
    if (shot) return shot;
    const { physW, physH } = display();
    const scale = Math.min(1, SHOT_LONG_EDGE / Math.max(physW, physH));
    return { w: Math.round(physW * scale), h: Math.round(physH * scale) };
  }

  // Bildschirmfoto-Koordinaten -> echte Bildschirmpixel
  function toPhysical([x, y]) {
    const { physW, physH } = display();
    const s = shotSize();
    const px = Math.round((Number(x) * physW) / s.w);
    const py = Math.round((Number(y) * physH) / s.h);
    if (!Number.isFinite(px) || !Number.isFinite(py)) throw new Error('Ungültige Koordinate.');
    return [Math.min(physW - 1, Math.max(0, px)), Math.min(physH - 1, Math.max(0, py))];
  }

  function toShot([px, py]) {
    const { physW, physH } = display();
    const s = shotSize();
    return [Math.round((px * s.w) / physW), Math.round((py * s.h) / physH)];
  }

  // Für die Klick-Welle im Overlay (in DIP relativ zum Bildschirm)
  function pointer(phys, kind) {
    const { d } = display();
    onPointer?.(phys[0] / d.scaleFactor, phys[1] / d.scaleFactor, kind);
  }

  async function grab(width, height) {
    await beforeCapture?.();
    try {
      const { d } = display();
      const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width, height } });
      const source = sources.find((s) => s.display_id === String(d.id)) || sources[0];
      if (!source || source.thumbnail.isEmpty()) throw new Error('Bildschirmfoto fehlgeschlagen.');
      return source.thumbnail;
    } finally {
      await afterCapture?.();
    }
  }

  function toImage(img) {
    return {
      type: 'image',
      source: { type: 'base64', media_type: 'image/jpeg', data: img.toJPEG(82).toString('base64') },
    };
  }

  async function screenshot() {
    const target = shotSize();
    const img = await grab(target.w, target.h);
    const size = img.getSize();
    shot = { w: size.width, h: size.height };
    return toImage(img);
  }

  async function zoom(region) {
    if (!Array.isArray(region) || region.length !== 4) throw new Error('region braucht [x0, y0, x1, y1].');
    const [x0, y0] = toPhysical([region[0], region[1]]);
    const [x1, y1] = toPhysical([region[2], region[3]]);
    const { physW, physH } = display();
    const full = await grab(physW, physH);
    const size = full.getSize();
    const fx = size.width / physW;
    const fy = size.height / physH;
    const rect = {
      x: Math.round(Math.min(x0, x1) * fx),
      y: Math.round(Math.min(y0, y1) * fy),
      width: Math.max(8, Math.round(Math.abs(x1 - x0) * fx)),
      height: Math.max(8, Math.round(Math.abs(y1 - y0) * fy)),
    };
    let img = full.crop(rect);
    const s = Math.min(1, SHOT_LONG_EDGE / Math.max(rect.width, rect.height));
    if (s < 1) img = img.resize({ width: Math.round(rect.width * s), height: Math.round(rect.height * s), quality: 'good' });
    return toImage(img);
  }

  async function withModifiers(text, fn) {
    const mods = text ? parseCombo(text) : [];
    for (const m of mods) await pressKey(m, false);
    try {
      await fn();
    } finally {
      for (const m of [...mods].reverse()) await pressKey(m, true);
    }
  }

  function pressKey(k, up) {
    return k.char ? helper.send({ op: 'keychar', b64: b64(k.char), up }) : helper.send({ op: 'key', vk: k.vk, ext: k.ext, up });
  }

  async function moveTo(coordinate, kind) {
    const phys = toPhysical(coordinate);
    await helper.send({ op: 'move', x: phys[0], y: phys[1] });
    pointer(phys, kind);
    return phys;
  }

  async function input(fn) {
    beforeInput?.();
    try {
      return await fn();
    } finally {
      afterInput?.();
    }
  }

  // Führt eine Aktion aus und liefert Inhalte für das tool_result.
  async function run(name, args = {}, signal) {
    switch (name) {
      case 'screenshot':
        return [await screenshot()];
      case 'zoom':
        return [await zoom(args.region)];
      case 'cursor_position': {
        const [x, y] = (await helper.send({ op: 'pos' })).split(',').map(Number);
        const [sx, sy] = toShot([x, y]);
        return [{ type: 'text', text: `X=${sx}, Y=${sy}` }];
      }
      case 'wait':
        await sleep(Math.min(MAX_WAIT_S, Math.max(0, Number(args.duration) || 1)) * 1000, signal);
        return [{ type: 'text', text: 'OK' }];
    }

    await input(async () => {
      switch (name) {
        case 'left_click':
        case 'right_click':
        case 'middle_click':
        case 'double_click':
        case 'triple_click': {
          const btn = name === 'right_click' ? 'right' : name === 'middle_click' ? 'middle' : 'left';
          const count = name === 'double_click' ? 2 : name === 'triple_click' ? 3 : 1;
          if (args.coordinate) await moveTo(args.coordinate, 'click');
          await withModifiers(args.text, () => helper.send({ op: 'click', btn, count }));
          break;
        }
        case 'mouse_move':
          await moveTo(args.coordinate, 'move');
          break;
        case 'left_mouse_down':
          await helper.send({ op: 'button', btn: 'left', down: true });
          break;
        case 'left_mouse_up':
          await helper.send({ op: 'button', btn: 'left', down: false });
          break;
        case 'left_click_drag': {
          if (!args.start_coordinate || !args.coordinate) throw new Error('start_coordinate und coordinate nötig.');
          const from = toPhysical(args.start_coordinate);
          const to = toPhysical(args.coordinate);
          await withModifiers(args.text, async () => {
            await helper.send({ op: 'move', x: from[0], y: from[1] });
            pointer(from, 'click');
            await helper.send({ op: 'button', btn: 'left', down: true });
            for (let i = 1; i <= 12; i += 1) {
              const x = Math.round(from[0] + ((to[0] - from[0]) * i) / 12);
              const y = Math.round(from[1] + ((to[1] - from[1]) * i) / 12);
              await helper.send({ op: 'move', x, y });
              await sleep(12);
            }
            await helper.send({ op: 'button', btn: 'left', down: false });
            pointer(to, 'click');
          });
          break;
        }
        case 'scroll': {
          if (args.coordinate) await moveTo(args.coordinate, 'move');
          const amount = Math.min(30, Math.max(1, Math.round(Number(args.scroll_amount) || 3)));
          const dir = args.scroll_direction;
          const dy = dir === 'up' ? amount : dir === 'down' ? -amount : 0;
          const dx = dir === 'right' ? amount : dir === 'left' ? -amount : 0;
          if (!dx && !dy) throw new Error('scroll_direction muss up, down, left oder right sein.');
          await withModifiers(args.text, () => helper.send({ op: 'scroll', dx, dy }));
          break;
        }
        case 'type': {
          const text = String(args.text ?? '');
          for (let i = 0; i < text.length; i += 200) {
            await helper.send({ op: 'type', b64: b64(text.slice(i, i + 200)) });
            if (signal?.aborted) break;
          }
          break;
        }
        case 'key': {
          const keys = parseCombo(args.text);
          const repeat = Math.min(100, Math.max(1, Math.round(Number(args.repeat) || 1)));
          for (let r = 0; r < repeat; r += 1) {
            for (const k of keys) await pressKey(k, false);
            for (const k of [...keys].reverse()) await pressKey(k, true);
            if (signal?.aborted) break;
          }
          break;
        }
        case 'hold_key': {
          const keys = parseCombo(args.text);
          for (const k of keys) await pressKey(k, false);
          try {
            await sleep(Math.min(MAX_WAIT_S, Math.max(0, Number(args.duration) || 1)) * 1000, signal);
          } finally {
            for (const k of [...keys].reverse()) await pressKey(k, true);
          }
          break;
        }
        default:
          throw new Error(`Unbekannte Aktion: ${name}`);
      }
    });
    // Kurz warten, damit die Oberfläche reagieren kann
    await sleep(name === 'type' || name === 'key' ? 250 : 350, signal).catch(() => {});
    return [{ type: 'text', text: 'OK' }];
  }

  function describe(name, args = {}) {
    switch (name) {
      case 'screenshot': return 'schaut hin';
      case 'zoom': return 'schaut genauer hin';
      case 'type': return 'tippt';
      case 'key': return `drückt ${String(args.text || '').replace(/\+/g, ' + ')}`;
      case 'hold_key': return 'hält eine Taste';
      case 'scroll': return 'scrollt';
      case 'wait': return 'wartet';
      case 'mouse_move': return 'bewegt die Maus';
      case 'left_click_drag': return 'zieht';
      case 'cursor_position': return 'sucht die Maus';
      case 'right_click': return 'Rechtsklick';
      case 'double_click': return 'Doppelklick';
      default: return 'klickt';
    }
  }

  return {
    run,
    describe,
    warmUp: () => helper.start().catch(() => {}),
    stop: () => helper.stop(),
    screenSize: () => shotSize(),
    get fakeLog() { return helper.fake; },
  };
}

// Windows 10 2004+ kann Fenster aus Bildschirmfotos ausblenden.
function supportsCaptureExclusion() {
  if (process.platform !== 'win32') return false;
  const build = Number(os.release().split('.')[2] || 0);
  return build >= 19041;
}

module.exports = { createComputer, parseCombo, resolveKey, supportsCaptureExclusion, HELPER_SCRIPT };
