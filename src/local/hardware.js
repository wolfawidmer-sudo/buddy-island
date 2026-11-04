// @ts-check
// Hardware-Erkennung für die lokale KI.
//
// Windows: ein einziger PowerShell-Aufruf liest Betriebssystem, Prozessor (inkl. AVX/AVX2/AVX-512
// über IsProcessorFeaturePresent), alle Grafikkarten (Win32_VideoController) und den echten
// Grafikspeicher aus der Registry (HardwareInformation.qwMemorySize; AdapterRAM ist ein
// 32-Bit-Wert und endet bei 4 GB). NVIDIA-Karten liefern über nvidia-smi zusätzlich freien
// Speicher, Treiber und Compute Capability. Linux/macOS: /proc, os-Modul, nvidia-smi.
//
// Ergebnis sind Fakten plus «mögliche» Beschleuniger. Ob die Grafikkarte wirklich rechnet,
// steht erst fest, wenn ein Modell geladen ist (siehe ollama.js: ps → size_vram).

const os = require('os');
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

/** @typedef {'nvidia'|'amd'|'intel'|'apple'|'other'} Vendor */
/**
 * @typedef {{
 *   name: string, vendor: Vendor, integrated: boolean,
 *   vramGB: number|null, freeVramGB: number|null,
 *   driver: string|null, computeCap: number|null,
 *   backends: string[], notes: string[], source: string,
 * }} Gpu
 */
/**
 * @typedef {{
 *   os: { platform: string, release: string, name: string, build: number|null, arch: string },
 *   cpu: { name: string, vendor: string, cores: number, threads: number, avx: boolean|null, avx2: boolean|null, avx512: boolean|null },
 *   ram: { totalGB: number, freeGB: number },
 *   gpus: Gpu[],
 *   disk: { path: string, freeGB: number|null, totalGB: number|null } | null,
 *   vulkan: boolean|null,
 *   backends: string[],
 *   primary: Gpu|null,
 *   errors: string[],
 *   at: number,
 * }} Hardware
 */

const GB = 1024 ** 3;
const round1 = (/** @type {number} */ x) => Math.round(x * 10) / 10;

// Mindest-Treiber für CUDA in Ollama (docs.ollama.com/windows): 551.61
const MIN_NVIDIA_DRIVER = 551.61;

/**
 * @param {string} cmd @param {string[]} args @param {number} [timeout]
 * @returns {Promise<string|null>}
 */
function run(cmd, args, timeout = 15000) {
  return new Promise((resolve) => {
    try {
      execFile(cmd, args, { timeout, windowsHide: true, maxBuffer: 4 * 1024 * 1024, encoding: 'utf8', env: require('./ollama').envFor(cmd) }, (err, out) => resolve(err ? null : String(out || '').trim()));
    } catch {
      resolve(null);
    }
  });
}

/** @param {string} name @returns {Vendor} */
function vendorOf(name) {
  const n = String(name || '').toLowerCase();
  if (/nvidia|geforce|quadro|tesla|\brtx\b|\bgtx\b/.test(n)) return 'nvidia';
  if (/\bamd\b|radeon|advanced micro devices|\bati\b/.test(n)) return 'amd';
  if (/intel/.test(n)) return 'intel';
  if (/apple/.test(n)) return 'apple';
  return 'other';
}

/**
 * Integrierte Grafik (teilt sich den Arbeitsspeicher). Intel «Arc(TM) Graphics» ohne
 * Modellnummer ist die Grafik der Core-Ultra-Prozessoren, «Arc A770»/«B580» sind Karten.
 * @param {string} name @param {Vendor} vendor
 */
function isIntegrated(name, vendor) {
  const n = String(name || '').toLowerCase();
  if (vendor === 'intel') return !/arc\S*\s*(\(tm\))?\s*(pro\s+)?[ab]\d{3}/i.test(n);
  if (vendor === 'amd') return /radeon\s*\(tm\)\s*graphics|radeon graphics\s*$|vega\s*\d+\s*graphics|radeon\s*\d{3,4}m\b|radeon\s*(\(tm\)\s*)?\d{3}m|radeon.*\bsecond\b|780m|890m|880m|760m|680m|660m|8060s|8050s|8040s/.test(n);
  if (vendor === 'apple') return true;
  return false;
}

/** Windows-Treiberversion «32.0.15.6109» → NVIDIA-Version 561.09 @param {string|null} v */
function nvidiaDriverFromWindows(v) {
  const digits = String(v || '').replace(/\D/g, '');
  if (digits.length < 5) return null;
  const last5 = digits.slice(-5);
  return Number(`${last5.slice(0, 3)}.${last5.slice(3)}`);
}

/**
 * Ausgabe von nvidia-smi --query-gpu=name,memory.total,memory.free,driver_version,compute_cap
 * @param {string|null} out
 */
function parseNvidiaSmi(out) {
  /** @type {{name: string, totalGB: number|null, freeGB: number|null, driver: string|null, computeCap: number|null}[]} */
  const list = [];
  for (const line of String(out || '').split(/\r?\n/)) {
    const [name, total, free, driver, cap] = line.split(',').map((x) => x.trim());
    if (!name || /not supported|error|failed/i.test(name)) continue;
    const num = (/** @type {string|undefined} */ x) => (x && /^\d+(\.\d+)?$/.test(x) ? Number(x) : null);
    const t = num(total);
    const f = num(free);
    list.push({ name, totalGB: t !== null ? round1(t / 1024) : null, freeGB: f !== null ? round1(f / 1024) : null, driver: driver || null, computeCap: num(cap) });
  }
  return list;
}

/**
 * Welche Beschleuniger für eine Grafikkarte in Frage kommen (noch nicht bestätigt).
 * @param {Gpu} g @param {{vulkan: boolean|null}} sys
 */
function backendsFor(g, sys) {
  /** @type {string[]} */
  const b = [];
  /** @type {string[]} */
  const notes = [];
  if (g.vendor === 'nvidia') {
    const drv = Number(g.driver);
    const capOk = g.computeCap === null || g.computeCap >= 5.0;
    if (!capOk) notes.push('old_gpu');
    if (Number.isFinite(drv) && drv > 0 && drv < MIN_NVIDIA_DRIVER) notes.push('old_driver');
    else if (capOk) b.push('cuda');
    if (sys.vulkan !== false) b.push('vulkan');
  } else if (g.vendor === 'amd') {
    // ROCm unter Windows nur für neuere Radeon-Karten (RDNA2 ab RX 6800, RDNA3, RDNA4).
    // Vulkan läuft breiter und ist in Ollama standardmässig an.
    if (!g.integrated && /rx\s*(6[89]\d0|7\d{3}|9\d{3})|radeon pro w[67]\d{3}|radeon ai pro/i.test(g.name)) b.push('rocm');
    if (sys.vulkan !== false) b.push('vulkan');
  } else if (g.vendor === 'intel') {
    if (sys.vulkan !== false) b.push('vulkan');
  } else if (g.vendor === 'apple') {
    b.push('metal');
  }
  if (g.integrated && g.vendor !== 'apple') notes.push('shared_memory');
  return { backends: b, notes };
}

// ---------------- Windows ----------------

// Läuft unter Windows PowerShell 5.1 (ohne Zusatzmodule). Fehler einzelner Teile brechen nicht ab.
const PS_PROBE = String.raw`
$ErrorActionPreference = 'SilentlyContinue'
$r = [ordered]@{}
try { $o = Get-CimInstance Win32_OperatingSystem; $r.os = @{ caption = $o.Caption; version = $o.Version; build = [int]$o.BuildNumber; freeKB = [int64]$o.FreePhysicalMemory; totalKB = [int64]$o.TotalVisibleMemorySize } } catch {}
try { $c = @(Get-CimInstance Win32_Processor); $r.cpu = @{ name = $c[0].Name; maker = $c[0].Manufacturer; cores = ($c | Measure-Object NumberOfCores -Sum).Sum; threads = ($c | Measure-Object NumberOfLogicalProcessors -Sum).Sum } } catch {}
try {
  Add-Type -Namespace BuddyHw -Name K -MemberDefinition '[DllImport("kernel32.dll")] public static extern bool IsProcessorFeaturePresent(int f);'
  $r.feat = @{ avx = [BuddyHw.K]::IsProcessorFeaturePresent(39); avx2 = [BuddyHw.K]::IsProcessorFeaturePresent(40); avx512 = [BuddyHw.K]::IsProcessorFeaturePresent(41) }
} catch {}
$r.video = @(Get-CimInstance Win32_VideoController | ForEach-Object { @{ name = $_.Name; ram = [int64]$_.AdapterRAM; driver = $_.DriverVersion; pnp = $_.PNPDeviceID; status = $_.Status } })
$r.reg = @(Get-ChildItem 'HKLM:\SYSTEM\CurrentControlSet\Control\Class\{4d36e968-e325-11ce-bfc1-08002be10318}' -ErrorAction SilentlyContinue | ForEach-Object {
  $p = Get-ItemProperty $_.PSPath -ErrorAction SilentlyContinue
  if ($p.DriverDesc) {
    $q = $p.'HardwareInformation.qwMemorySize'
    $m = $p.'HardwareInformation.MemorySize'
    if ($m -is [byte[]]) { $m = [BitConverter]::ToUInt32($m, 0) }
    @{ desc = $p.DriverDesc; qw = [int64]$q; mem = [int64]$m; driver = $p.DriverVersion; dev = $p.MatchingDeviceId }
  }
})
$r.vulkan = Test-Path (Join-Path $env:SystemRoot 'System32\vulkan-1.dll')
$r | ConvertTo-Json -Depth 4 -Compress
`;

/**
 * Wertet die Ausgabe von PS_PROBE (und optional nvidia-smi) aus. Rein, darum testbar.
 * @param {any} probe @param {ReturnType<typeof parseNvidiaSmi>} smi
 * @returns {{ gpus: Gpu[], vulkan: boolean|null, cpu: Partial<Hardware['cpu']>, os: Partial<Hardware['os']>, ram: Partial<Hardware['ram']> }}
 */
function parseWindowsProbe(probe, smi = []) {
  const p = probe && typeof probe === 'object' ? probe : {};
  const vulkan = typeof p.vulkan === 'boolean' ? p.vulkan : null;
  const video = Array.isArray(p.video) ? p.video : p.video ? [p.video] : [];
  const reg = Array.isArray(p.reg) ? p.reg : p.reg ? [p.reg] : [];
  /** @type {Gpu[]} */
  const gpus = [];
  const usedSmi = new Set();
  for (const v of video) {
    const name = String(v?.name || '').trim();
    if (!name || /basic display|basic render|remote display|virtual|parsec|meta virtual|indirect display|displaylink|citrix|vnc|rdp/i.test(name)) continue;
    const vendor = vendorOf(name);
    const integrated = isIntegrated(name, vendor);
    // Echter Grafikspeicher aus der Registry (gleiche Bezeichnung), sonst AdapterRAM (max. 4 GB)
    const r = reg.find((x) => String(x?.desc || '').trim() === name);
    let bytes = Number(r?.qw) || 0;
    if (!bytes) bytes = Number(r?.mem) || 0;
    let fromAdapter = false;
    if (!bytes) { bytes = Number(v.ram) || 0; fromAdapter = true; }
    if (bytes < 0) bytes += 2 ** 32; // vorzeichenbehafteter 32-Bit-Wert
    let vramGB = bytes > 0 ? round1(bytes / GB) : null;
    // AdapterRAM endet bei 4 GB: dann unbekannt statt falsch
    if (fromAdapter && vramGB !== null && vramGB >= 3.9) vramGB = null;
    let driver = v.driver || r?.driver || null;
    /** @type {number|null} */
    let freeVramGB = null;
    /** @type {number|null} */
    let computeCap = null;
    let source = 'Windows';
    if (vendor === 'nvidia') {
      const i = smi.findIndex((s, idx) => !usedSmi.has(idx) && (s.name === name || name.includes(s.name) || s.name.includes(name.replace(/^NVIDIA\s+/i, ''))));
      const s = i >= 0 ? smi[i] : null;
      if (s) {
        usedSmi.add(i);
        if (s.totalGB) vramGB = s.totalGB;
        freeVramGB = s.freeGB;
        computeCap = s.computeCap;
        driver = s.driver || String(nvidiaDriverFromWindows(driver) || driver);
        source = 'nvidia-smi';
      } else {
        const d = nvidiaDriverFromWindows(driver);
        if (d) driver = String(d);
      }
    }
    /** @type {Gpu} */
    const gpu = { name, vendor, integrated, vramGB: integrated ? null : vramGB, freeVramGB, driver: driver ? String(driver) : null, computeCap, backends: [], notes: [], source };
    if (v.status && !/^ok$/i.test(String(v.status))) gpu.notes.push('device_problem');
    const b = backendsFor(gpu, { vulkan });
    gpu.backends = b.backends;
    gpu.notes.push(...b.notes);
    gpus.push(gpu);
  }
  // nvidia-smi kennt Karten, die Windows nicht (oder anders) meldet
  smi.forEach((s, i) => {
    if (usedSmi.has(i)) return;
    /** @type {Gpu} */
    const gpu = { name: s.name, vendor: 'nvidia', integrated: false, vramGB: s.totalGB, freeVramGB: s.freeGB, driver: s.driver, computeCap: s.computeCap, backends: [], notes: [], source: 'nvidia-smi' };
    const b = backendsFor(gpu, { vulkan });
    gpu.backends = b.backends;
    gpu.notes.push(...b.notes);
    gpus.push(gpu);
  });
  const feat = p.feat || {};
  const cpu = {
    ...(p.cpu?.name ? { name: String(p.cpu.name).replace(/\s+/g, ' ').trim() } : {}),
    ...(p.cpu?.maker ? { vendor: /intel/i.test(p.cpu.maker) ? 'Intel' : /amd/i.test(p.cpu.maker) ? 'AMD' : String(p.cpu.maker) } : {}),
    ...(Number(p.cpu?.cores) ? { cores: Number(p.cpu.cores) } : {}),
    ...(Number(p.cpu?.threads) ? { threads: Number(p.cpu.threads) } : {}),
    // Ältere Windows-Versionen kennen die Abfrage nicht (dann false): ab Build 19041 verlässlich
    ...(typeof feat.avx2 === 'boolean' && (Number(p.os?.build) >= 19041 || feat.avx2) ? { avx: Boolean(feat.avx), avx2: Boolean(feat.avx2), avx512: Boolean(feat.avx512) } : {}),
  };
  const osInfo = p.os ? { name: String(p.os.caption || '').replace(/^Microsoft\s+/i, '').trim(), build: Number(p.os.build) || null } : {};
  const ram = p.os?.totalKB ? { totalGB: round1((Number(p.os.totalKB) * 1024) / GB), freeGB: round1((Number(p.os.freeKB) * 1024) / GB) } : {};
  return { gpus, vulkan, cpu, os: osInfo, ram };
}

// ---------------- Linux / macOS ----------------

/** @param {string} cpuinfo */
function cpuFlagsLinux(cpuinfo) {
  const m = /^flags\s*:\s*(.*)$/m.exec(cpuinfo || '');
  if (!m) return null;
  const f = new Set(m[1].split(/\s+/));
  return { avx: f.has('avx'), avx2: f.has('avx2'), avx512: f.has('avx512f') };
}

/** MemAvailable aus /proc/meminfo (os.freemem zählt den Cache nicht mit) @param {string} meminfo */
function memAvailableLinux(meminfo) {
  const m = /^MemAvailable:\s+(\d+)\s*kB/m.exec(meminfo || '');
  return m ? round1((Number(m[1]) * 1024) / GB) : null;
}

/** Bevorzugte Grafikkarte für die KI: eigene Karte mit dem meisten Speicher @param {Gpu[]} gpus */
function pickPrimary(gpus) {
  const usable = gpus.filter((g) => !g.integrated && g.backends.length && !g.notes.includes('old_gpu'));
  usable.sort((a, b) => (b.vramGB || 0) - (a.vramGB || 0) || (a.vendor === 'nvidia' ? -1 : 1));
  return usable[0] || null;
}

/**
 * @param {string} dir
 * @returns {Promise<{path: string, freeGB: number|null, totalGB: number|null}|null>}
 */
async function diskInfo(dir) {
  // Nächster existierender Ordner (der Modellordner gibt es vielleicht noch nicht)
  let d = dir;
  for (let i = 0; i < 20 && d; i += 1) {
    try { await fs.promises.access(d); break; } catch { const up = path.dirname(d); if (up === d) break; d = up; }
  }
  try {
    const s = await fs.promises.statfs(d);
    return { path: dir, freeGB: round1((s.bavail * s.bsize) / GB), totalGB: round1((s.blocks * s.bsize) / GB) };
  } catch {
    return { path: dir, freeGB: null, totalGB: null };
  }
}

/**
 * Erkennt die Hardware. Schlägt etwas fehl, bleiben die Angaben leer und `errors` sagt,
 * was fehlt; die Empfehlung rechnet dann vorsichtig nur mit dem Prozessor.
 * @param {{ modelsDir?: string, runImpl?: typeof run, platform?: string, readFile?: (p: string) => string }} [opts]
 * @returns {Promise<Hardware>}
 */
async function detect(opts = {}) {
  const exec = opts.runImpl || run;
  const platform = opts.platform || process.platform;
  const readFile = opts.readFile || ((/** @type {string} */ p) => fs.readFileSync(p, 'utf8'));
  /** @type {string[]} */
  const errors = [];
  const cpus = os.cpus();
  /** @type {Hardware['cpu']} */
  const cpu = {
    name: (cpus[0]?.model || '').replace(/\s+/g, ' ').trim() || 'Unbekannt',
    vendor: /intel/i.test(cpus[0]?.model || '') ? 'Intel' : /amd/i.test(cpus[0]?.model || '') ? 'AMD' : /apple/i.test(cpus[0]?.model || '') ? 'Apple' : '',
    cores: Math.max(1, Math.round(cpus.length / 2)),
    threads: Math.max(1, cpus.length),
    avx: null, avx2: null, avx512: null,
  };
  /** @type {Hardware['ram']} */
  const ram = { totalGB: round1(os.totalmem() / GB), freeGB: round1(os.freemem() / GB) };
  /** @type {Hardware['os']} */
  const osInfo = { platform, release: os.release(), name: platform === 'win32' ? 'Windows' : platform === 'darwin' ? 'macOS' : 'Linux', build: null, arch: os.arch() };
  /** @type {Gpu[]} */
  let gpus = [];
  /** @type {boolean|null} */
  let vulkan = null;

  const smiArgs = ['--query-gpu=name,memory.total,memory.free,driver_version,compute_cap', '--format=csv,noheader,nounits'];
  const smiPromise = exec('nvidia-smi', smiArgs, 10000).then((out) => out || exec('nvidia-smi', ['--query-gpu=name,memory.total,memory.free,driver_version', '--format=csv,noheader,nounits'], 10000));

  if (platform === 'win32') {
    const [out, smiOut] = await Promise.all([
      exec('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', PS_PROBE], 25000),
      smiPromise,
    ]);
    let probe = null;
    try { probe = out ? JSON.parse(out.slice(out.indexOf('{'))) : null; } catch { probe = null; }
    if (!probe) errors.push('windows_probe');
    const parsed = parseWindowsProbe(probe, parseNvidiaSmi(smiOut));
    gpus = parsed.gpus;
    vulkan = parsed.vulkan;
    Object.assign(cpu, parsed.cpu);
    Object.assign(osInfo, parsed.os);
    if (parsed.ram.totalGB) Object.assign(ram, parsed.ram);
  } else {
    const smi = parseNvidiaSmi(await smiPromise);
    for (const s of smi) {
      /** @type {Gpu} */
      const g = { name: s.name, vendor: 'nvidia', integrated: false, vramGB: s.totalGB, freeVramGB: s.freeGB, driver: s.driver, computeCap: s.computeCap, backends: [], notes: [], source: 'nvidia-smi' };
      const b = backendsFor(g, { vulkan: null });
      g.backends = b.backends.filter((x) => x === 'cuda');
      g.notes = b.notes;
      gpus.push(g);
    }
    if (platform === 'linux') {
      try {
        const flags = cpuFlagsLinux(readFile('/proc/cpuinfo'));
        if (flags) Object.assign(cpu, flags);
      } catch { errors.push('cpuinfo'); }
      try {
        const avail = memAvailableLinux(readFile('/proc/meminfo'));
        if (avail !== null) ram.freeGB = avail;
      } catch { /* os.freemem reicht */ }
    } else if (platform === 'darwin' && os.arch() === 'arm64') {
      gpus.push({ name: 'Apple Silicon', vendor: 'apple', integrated: true, vramGB: null, freeVramGB: null, driver: null, computeCap: null, backends: ['metal'], notes: ['shared_memory'], source: 'System' });
    }
  }

  const disk = opts.modelsDir ? await diskInfo(opts.modelsDir) : null;
  const primary = pickPrimary(gpus);
  const backends = [...new Set([...gpus.flatMap((g) => g.backends), 'cpu'])];
  return { os: osInfo, cpu, ram, gpus, disk, vulkan, backends, primary, errors, at: Date.now() };
}

/** Freier Arbeitsspeicher jetzt (schnell, ohne PowerShell) */
function freeRamGB() {
  if (process.platform === 'linux') {
    try { const v = memAvailableLinux(fs.readFileSync('/proc/meminfo', 'utf8')); if (v !== null) return v; } catch { /* os */ }
  }
  return round1(os.freemem() / GB);
}

/**
 * Kurzfassung für die Oberfläche (ohne Fachbegriffe)
 * @param {Hardware} hw
 */
function summary(hw) {
  const g = hw.primary;
  const shared = hw.gpus.find((x) => x.integrated);
  return {
    ramGB: hw.ram.totalGB,
    freeRamGB: hw.ram.freeGB,
    cpu: hw.cpu.name,
    threads: hw.cpu.threads,
    gpu: g ? g.name : shared ? shared.name : null,
    vramGB: g ? g.vramGB : null,
    gpuKind: g ? 'dedicated' : shared ? 'integrated' : 'none',
    diskFreeGB: hw.disk?.freeGB ?? null,
    os: hw.os.name,
  };
}

module.exports = { detect, summary, freeRamGB, parseWindowsProbe, parseNvidiaSmi, vendorOf, isIntegrated, backendsFor, nvidiaDriverFromWindows, cpuFlagsLinux, memAvailableLinux, pickPrimary, diskInfo, PS_PROBE, MIN_NVIDIA_DRIVER };
