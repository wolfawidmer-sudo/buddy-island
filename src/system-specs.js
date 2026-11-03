// @ts-check
// Erkennt die Hardware (Arbeitsspeicher, Prozessor, Grafikkarte und Grafikspeicher) und
// empfiehlt passende lokale Hugging-Face-Modelle: eines für die schnellsten Antworten und
// eines für die besten Antworten, die dieser PC noch flüssig schafft.
//
// Schätzung des Speicherbedarfs: Transformers lädt Modelle ohne Quantisierung in 16 Bit,
// also etwa 2 Byte pro Parameter, plus rund 20 % für Kontext und Laufzeit.

const os = require('os');
const { execFile } = require('child_process');
const { t } = require('./i18n');

/** @typedef {{ name: string, vramGB: number|null, vendor: string, source: string }} Gpu */
/** @typedef {{ ramGB: number, freeRamGB: number, cpu: string, cores: number, threads: number, platform: string, arch: string, gpus: Gpu[], cuda: boolean, cudaVramGB: number|null, at: number }} Specs */
/** @typedef {{ id: string, name: string, params: number, gated?: boolean, license: string, langs: string, note: string }} Candidate */

// Kuratierte, frei verfügbare Chat-Modelle mit guter Mehrsprachigkeit (inkl. Deutsch),
// von klein/schnell nach gross/gut sortiert. Alle laufen direkt mit `transformers`.
/** @type {Candidate[]} */
const CANDIDATES = [
  { id: 'Qwen/Qwen2.5-0.5B-Instruct', name: 'Qwen2.5 0.5B', params: 0.5, license: 'Apache 2.0', langs: 'mehrsprachig', note: 'Sehr schnell, für kurze Fragen' },
  { id: 'Qwen/Qwen2.5-1.5B-Instruct', name: 'Qwen2.5 1.5B', params: 1.5, license: 'Apache 2.0', langs: 'mehrsprachig', note: 'Schnell und brauchbar im Alltag' },
  { id: 'HuggingFaceTB/SmolLM2-1.7B-Instruct', name: 'SmolLM2 1.7B', params: 1.7, license: 'Apache 2.0', langs: 'vor allem Englisch', note: 'Klein, von Hugging Face selbst' },
  { id: 'Qwen/Qwen2.5-3B-Instruct', name: 'Qwen2.5 3B', params: 3, license: 'Qwen Research', langs: 'mehrsprachig', note: 'Gute Balance aus Tempo und Qualität' },
  { id: 'microsoft/Phi-3.5-mini-instruct', name: 'Phi-3.5 mini', params: 3.8, license: 'MIT', langs: 'mehrsprachig', note: 'Stark beim Denken für seine Grösse' },
  { id: 'Qwen/Qwen2.5-7B-Instruct', name: 'Qwen2.5 7B', params: 7.6, license: 'Apache 2.0', langs: 'mehrsprachig', note: 'Deutlich klüger, braucht eine starke Grafikkarte' },
  { id: 'Qwen/Qwen2.5-14B-Instruct', name: 'Qwen2.5 14B', params: 14.7, license: 'Apache 2.0', langs: 'mehrsprachig', note: 'Sehr gut, nur mit viel Grafikspeicher' },
];

/** @param {number} params Milliarden Parameter → GB Speicher in 16 Bit inkl. Reserve */
const memoryFor = (params) => Math.round(params * 2 * 1.2 * 10) / 10;

/**
 * @param {string} cmd @param {string[]} args @param {number} [timeout]
 * @returns {Promise<string|null>}
 */
function run(cmd, args, timeout = 8000) {
  return new Promise((resolve) => {
    try {
      execFile(cmd, args, { timeout, windowsHide: true, maxBuffer: 1024 * 1024 }, (err, out) => resolve(err ? null : String(out || '').trim()));
    } catch {
      resolve(null);
    }
  });
}

/** @param {string} name */
function vendorOf(name) {
  const n = name.toLowerCase();
  if (n.includes('nvidia') || n.includes('geforce') || n.includes('rtx') || n.includes('quadro')) return 'nvidia';
  if (n.includes('amd') || n.includes('radeon')) return 'amd';
  if (n.includes('intel')) return 'intel';
  if (n.includes('apple')) return 'apple';
  return 'other';
}

/**
 * Grafikkarten finden. nvidia-smi kennt den echten Grafikspeicher; Windows meldet über
 * Win32_VideoController höchstens 4 GB, darum dort nur als Mindestwert.
 * @returns {Promise<Gpu[]>}
 */
async function detectGpus() {
  /** @type {Gpu[]} */
  const gpus = [];
  const smi = await run('nvidia-smi', ['--query-gpu=name,memory.total', '--format=csv,noheader,nounits']);
  if (smi) {
    for (const line of smi.split(/\r?\n/)) {
      const [name, mem] = line.split(',').map((x) => x.trim());
      if (name) gpus.push({ name, vramGB: Number(mem) ? Math.round((Number(mem) / 1024) * 10) / 10 : null, vendor: 'nvidia', source: 'nvidia-smi' });
    }
  }
  if (process.platform === 'win32') {
    const ps = 'Get-CimInstance Win32_VideoController | Select-Object Name,AdapterRAM | ConvertTo-Json -Compress';
    const out = await run('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', ps], 12000);
    if (out) {
      try {
        const list = JSON.parse(out);
        for (const g of Array.isArray(list) ? list : [list]) {
          const name = String(g.Name || '').trim();
          if (!name || /basic display|remote display|virtual/i.test(name)) continue;
          if (gpus.some((x) => x.name === name)) continue;
          const bytes = Number(g.AdapterRAM) || 0;
          // AdapterRAM ist ein 32-Bit-Wert: bei 4 GB und mehr ungenau
          const gb = bytes > 0 ? Math.round((bytes / 1024 ** 3) * 10) / 10 : null;
          gpus.push({ name, vramGB: gb && gb >= 3.9 ? null : gb, vendor: vendorOf(name), source: 'Windows' });
        }
      } catch { /* keine Angaben */ }
    }
  } else if (process.platform === 'darwin' && os.arch() === 'arm64') {
    gpus.push({ name: 'Apple Silicon', vramGB: null, vendor: 'apple', source: 'System' });
  }
  return gpus;
}

/**
 * @param {{ python?: { cuda: boolean, device: string } | null, cudaVramGB?: number|null }} [hints]
 * @returns {Promise<Specs>}
 */
async function detectSpecs(hints = {}) {
  const cpus = os.cpus();
  const gpus = await detectGpus();
  const nvidia = gpus.find((g) => g.vendor === 'nvidia');
  return {
    ramGB: Math.round((os.totalmem() / 1024 ** 3) * 10) / 10,
    freeRamGB: Math.round((os.freemem() / 1024 ** 3) * 10) / 10,
    cpu: (cpus[0]?.model || 'Unbekannt').replace(/\s+/g, ' ').trim(),
    cores: Math.max(1, Math.round(cpus.length / 2)),
    threads: cpus.length,
    platform: process.platform,
    arch: os.arch(),
    gpus,
    cuda: Boolean(hints.python?.cuda),
    cudaVramGB: hints.cudaVramGB ?? nvidia?.vramGB ?? null,
    at: Date.now(),
  };
}

/**
 * Empfehlung für schnellstes und bestes lokales Modell.
 * GPU (CUDA): alles, was in den Grafikspeicher passt, ist schnell.
 * Nur Prozessor: Tempo hängt stark von der Grösse ab; ab etwa 3 Mrd. Parametern
 * wird es auf normalen Laptops zäh (wenige Wörter pro Sekunde).
 * @param {Specs} specs
 */
function recommend(specs) {
  const gpuMem = specs.cuda && specs.cudaVramGB ? specs.cudaVramGB : null;
  // Auf der CPU höchstens die Hälfte des Arbeitsspeichers für das Modell einplanen
  const cpuBudget = specs.ramGB * 0.5;
  const strongCpu = specs.threads >= 12;

  const rated = CANDIDATES.map((c) => {
    const need = memoryFor(c.params);
    const onGpu = Boolean(gpuMem && need <= gpuMem * 0.9);
    const fitsRam = need <= cpuBudget;
    let speed;
    if (onGpu) speed = c.params <= 3 ? 'sehr schnell' : c.params <= 8 ? 'schnell' : 'flüssig';
    else if (fitsRam) speed = c.params <= 0.6 ? 'schnell' : c.params <= 1.8 ? 'flüssig' : c.params <= (strongCpu ? 4 : 3) ? 'langsam' : 'sehr langsam';
    else speed = 'passt nicht';
    const usable = onGpu || (fitsRam && speed !== 'sehr langsam');
    return { ...c, needGB: need, device: onGpu ? 'Grafikkarte' : 'Prozessor', speed, usable };
  });
  const usable = rated.filter((r) => r.usable);
  const fastest = usable[0] || rated[0];
  // «Bestes»: grösstes Modell, das noch mindestens «langsam» (bzw. auf der GPU «flüssig») läuft,
  // bevorzugt mehrsprachig, damit Deutsch, Französisch und Italienisch gut klappen
  // Was auf die Grafikkarte passt, ist um ein Vielfaches schneller als jedes CPU-Modell
  const onGpu = usable.filter((r) => r.device === 'Grafikkarte');
  const pool = onGpu.length ? onGpu : usable;
  const bestPool = pool.filter((r) => r.langs === 'mehrsprachig');
  const best = bestPool[bestPool.length - 1] || pool[pool.length - 1] || fastest;

  let summary;
  if (gpuMem) summary = t('Grafikkarte mit {gb} GB: Modelle bis etwa {n} Mrd. Parameter laufen schnell.', { gb: gpuMem, n: Math.floor((gpuMem * 0.9) / 2.4) });
  else if (specs.gpus.some((g) => g.vendor === 'nvidia') && !specs.cuda) summary = t('NVIDIA-Grafikkarte gefunden, aber PyTorch nutzt sie noch nicht (CUDA fehlt). Mit «pip install torch --index-url https://download.pytorch.org/whl/cu128» wird es viel schneller.');
  else summary = t('Ohne passende Grafikkarte rechnet der Prozessor ({threads} Threads, {ram} GB RAM). Kleine Modelle sind hier am besten.', { threads: specs.threads, ram: specs.ramGB });

  return { fastest, best, all: rated, summary };
}

module.exports = { detectSpecs, detectGpus, recommend, memoryFor, CANDIDATES };
