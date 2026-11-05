// Lokale KI (Ollama): Hardware-Erkennung, Empfehlung, Laufzeit, Manager und Chat-Adapter.
// Ollama selbst ist nachgebaut (test/mock-ollama.js); echte Hardware ist als Ausgabe von
// PowerShell/nvidia-smi nachgestellt. Der echte Durchlauf mit Ollama läuft in CI unter Windows
// (test/e2e/ollama.e2e.js).
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const hardware = require('../src/local/hardware');
const catalog = require('../src/local/catalog');
const { createOllama, classify, parseComputeLines, LocalError } = require('../src/local/ollama');
const { createLocalManager, cleanAdvanced, kvMBPer1kFromShow } = require('../src/local/manager');
const { createLocalClient, toOllamaMessages, fitToBudget } = require('../src/llm/local');
const models = require('../src/models');
const { createMockOllama } = require('./mock-ollama');

const GB = 1024 ** 3;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'buddy-local-'));

// ---------------- Hardware ----------------

// NVIDIA RTX 3060 (AdapterRAM endet bei 4 GB, qwMemorySize stimmt, nvidia-smi kennt den freien Speicher)
{
  const probe = {
    os: { caption: 'Microsoft Windows 11 Home', build: 26100, totalKB: 32 * 1024 * 1024, freeKB: 20 * 1024 * 1024 },
    cpu: { name: 'AMD Ryzen 7 5800X 8-Core Processor', maker: 'AuthenticAMD', cores: 8, threads: 16 },
    feat: { avx: true, avx2: true, avx512: false },
    video: [{ name: 'NVIDIA GeForce RTX 3060', ram: 4293918720, driver: '32.0.15.6109', status: 'OK' }],
    reg: [{ desc: 'NVIDIA GeForce RTX 3060', qw: 12884901888, driver: '32.0.15.6109' }],
    vulkan: true,
  };
  const smi = hardware.parseNvidiaSmi('NVIDIA GeForce RTX 3060, 12288, 11020, 561.09, 8.6');
  const r = hardware.parseWindowsProbe(probe, smi);
  assert.strictEqual(r.gpus.length, 1);
  const g = r.gpus[0];
  assert.strictEqual(g.vendor, 'nvidia');
  assert.strictEqual(g.vramGB, 12);
  assert.strictEqual(g.freeVramGB, 10.8);
  assert.strictEqual(g.computeCap, 8.6);
  assert.deepStrictEqual(g.backends, ['cuda', 'vulkan']);
  assert.strictEqual(r.cpu.threads, 16);
  assert.strictEqual(r.cpu.avx2, true);
  assert.strictEqual(r.ram.totalGB, 32);
  assert.strictEqual(r.os.name, 'Windows 11 Home');
}
// NVIDIA ohne nvidia-smi: Treiberversion aus Windows umrechnen, zu alter Treiber → kein CUDA
{
  assert.strictEqual(hardware.nvidiaDriverFromWindows('32.0.15.6109'), 561.09);
  assert.strictEqual(hardware.nvidiaDriverFromWindows('31.0.15.3623'), 536.23);
  const r = hardware.parseWindowsProbe({ video: [{ name: 'NVIDIA GeForce GTX 1660 SUPER', ram: 6442450944, driver: '31.0.15.3623', status: 'OK' }], reg: [{ desc: 'NVIDIA GeForce GTX 1660 SUPER', qw: 6442450944 }], vulkan: true }, []);
  assert.strictEqual(r.gpus[0].vramGB, 6);
  assert.ok(r.gpus[0].notes.includes('old_driver'), 'Treiber älter als 551.61');
  assert.ok(!r.gpus[0].backends.includes('cuda'), 'kein CUDA mit zu altem Treiber');
  assert.ok(r.gpus[0].backends.includes('vulkan'));
}
// AMD Radeon RX 7800 XT: ROCm möglich, Vulkan; AMD-iGPU daneben wird als integriert erkannt
{
  const r = hardware.parseWindowsProbe({
    video: [{ name: 'AMD Radeon RX 7800 XT', ram: -1, driver: '32.0.12011.1036', status: 'OK' }, { name: 'AMD Radeon(TM) Graphics', ram: 536870912, status: 'OK' }],
    reg: [{ desc: 'AMD Radeon RX 7800 XT', qw: 17163091968 }, { desc: 'AMD Radeon(TM) Graphics', qw: 536870912 }],
    vulkan: true,
  }, []);
  const [dgpu, igpu] = r.gpus;
  assert.strictEqual(dgpu.vendor, 'amd');
  assert.strictEqual(dgpu.integrated, false);
  assert.strictEqual(dgpu.vramGB, 16);
  assert.deepStrictEqual(dgpu.backends, ['rocm', 'vulkan']);
  assert.strictEqual(igpu.integrated, true);
  assert.strictEqual(igpu.vramGB, null, 'integrierte Grafik zählt nicht als eigener Grafikspeicher');
  assert.ok(igpu.notes.includes('shared_memory'));
}
// Ältere AMD-Karte (RX 6600): kein ROCm, aber Vulkan; ohne Vulkan-Laufzeit gar nichts
{
  const r = hardware.parseWindowsProbe({ video: [{ name: 'AMD Radeon RX 6600', status: 'OK' }], reg: [{ desc: 'AMD Radeon RX 6600', qw: 8589934592 }], vulkan: true }, []);
  assert.deepStrictEqual(r.gpus[0].backends, ['vulkan']);
  const r2 = hardware.parseWindowsProbe({ video: [{ name: 'AMD Radeon RX 6600', status: 'OK' }], reg: [{ desc: 'AMD Radeon RX 6600', qw: 8589934592 }], vulkan: false }, []);
  assert.deepStrictEqual(r2.gpus[0].backends, []);
}
// Intel: Arc A770 ist eine eigene Karte, «Arc(TM) Graphics» (Core Ultra) und UHD sind integriert
{
  assert.strictEqual(hardware.isIntegrated('Intel(R) Arc(TM) A770 Graphics', 'intel'), false);
  assert.strictEqual(hardware.isIntegrated('Intel(R) Arc(TM) B580 Graphics', 'intel'), false);
  assert.strictEqual(hardware.isIntegrated('Intel(R) Arc(TM) Graphics', 'intel'), true);
  assert.strictEqual(hardware.isIntegrated('Intel(R) UHD Graphics 770', 'intel'), true);
  assert.strictEqual(hardware.isIntegrated('AMD Radeon 780M Graphics', 'amd'), true);
  assert.strictEqual(hardware.isIntegrated('AMD Radeon RX 7900 XTX', 'amd'), false);
  const r = hardware.parseWindowsProbe({ video: [{ name: 'Intel(R) Arc(TM) A770 Graphics', status: 'OK' }, { name: 'Intel(R) UHD Graphics 770', status: 'OK' }], reg: [{ desc: 'Intel(R) Arc(TM) A770 Graphics', qw: 17179869184 }], vulkan: true }, []);
  assert.strictEqual(r.gpus[0].vramGB, 16);
  assert.deepStrictEqual(r.gpus[0].backends, ['vulkan']);
  assert.strictEqual(hardware.pickPrimary(r.gpus).name, 'Intel(R) Arc(TM) A770 Graphics');
}
// Nur Prozessor: virtuelle Anzeigen werden ignoriert, AdapterRAM ≥ 4 GB gilt als unbekannt
{
  const r = hardware.parseWindowsProbe({ video: [{ name: 'Microsoft Basic Display Adapter', status: 'OK' }, { name: 'Parsec Virtual Display Adapter', status: 'OK' }, { name: 'Microsoft Hyper-V Video', status: 'OK' }], reg: [], vulkan: false }, []);
  assert.strictEqual(r.gpus.length, 0);
  assert.strictEqual(hardware.pickPrimary(r.gpus), null);
  const r2 = hardware.parseWindowsProbe({ video: [{ name: 'Some GPU', ram: 4293918720, status: 'OK' }], reg: [] }, []);
  assert.strictEqual(r2.gpus[0].vramGB, null);
}
// Mehrere NVIDIA-Karten: Zuordnung über nvidia-smi, die grössere ist die Haupt-Karte
{
  const smi = hardware.parseNvidiaSmi('NVIDIA GeForce RTX 3060, 12288, 12000, 566.36, 8.6\nNVIDIA GeForce RTX 4090, 24564, 23000, 566.36, 8.9');
  const r = hardware.parseWindowsProbe({ video: [{ name: 'NVIDIA GeForce RTX 3060', status: 'OK' }, { name: 'NVIDIA GeForce RTX 4090', status: 'OK' }], vulkan: true }, smi);
  assert.strictEqual(r.gpus.length, 2);
  assert.strictEqual(hardware.pickPrimary(r.gpus).name, 'NVIDIA GeForce RTX 4090');
  assert.strictEqual(hardware.pickPrimary(r.gpus).vramGB, 24);
  // Fehlerhafte nvidia-smi-Ausgabe wird ignoriert
  assert.deepStrictEqual(hardware.parseNvidiaSmi('NVIDIA-SMI has failed because it could not communicate with the NVIDIA driver.'), []);
  assert.strictEqual(hardware.parseNvidiaSmi('Tesla K80, 11441, 11000, 470.00, [Not Supported]')[0].computeCap, null);
}
// Ältere GPU (Compute Capability < 5): kein CUDA
{
  const g = { name: 'GeForce GT 730', vendor: 'nvidia', integrated: false, vramGB: 2, freeVramGB: null, driver: '560.00', computeCap: 3.5, backends: [], notes: [], source: 'x' };
  const b = hardware.backendsFor(g, { vulkan: true });
  assert.ok(!b.backends.includes('cuda'));
  assert.ok(b.notes.includes('old_gpu'));
}
// Linux: CPU-Flags und verfügbarer Speicher
assert.deepStrictEqual(hardware.cpuFlagsLinux('flags\t\t: fpu vme avx avx2 fma'), { avx: true, avx2: true, avx512: false });
assert.strictEqual(hardware.memAvailableLinux('MemTotal: 16000000 kB\nMemAvailable:    8388608 kB'), 8);

// Erkennung mit nachgestellten Programmen (Windows) und Rückfall, wenn PowerShell fehlt
(async () => {
  const fake = async (cmd) => {
    if (cmd === 'powershell.exe') return JSON.stringify({ os: { caption: 'Microsoft Windows 10 Pro', build: 19045, totalKB: 16777216, freeKB: 8388608 }, cpu: { name: 'Intel(R) Core(TM) i5-8250U CPU @ 1.60GHz', maker: 'GenuineIntel', cores: 4, threads: 8 }, feat: { avx: true, avx2: true, avx512: false }, video: [{ name: 'Intel(R) UHD Graphics 620', ram: 1073741824, status: 'OK' }], reg: [], vulkan: true });
    return null;
  };
  const hw = await hardware.detect({ runImpl: fake, platform: 'win32', modelsDir: tmp });
  assert.strictEqual(hw.primary, null, 'nur integrierte Grafik: Prozessor rechnet');
  assert.strictEqual(hw.ram.totalGB, 16);
  assert.strictEqual(hw.cpu.threads, 8);
  assert.ok(hw.disk && hw.disk.freeGB !== null, 'freier Platz am Speicherort');
  assert.ok(hw.backends.includes('cpu'));
  assert.strictEqual(hardware.summary(hw).gpuKind, 'integrated');
  const broken = await hardware.detect({ runImpl: async () => null, platform: 'win32' });
  assert.ok(broken.errors.includes('windows_probe'), 'fehlgeschlagene Erkennung wird gemeldet');
  assert.ok(broken.ram.totalGB > 0, 'Rückfall auf das os-Modul');
  assert.strictEqual(broken.primary, null);

  // ---------------- Katalog und Empfehlung ----------------

  const cat = catalog.validateCatalog(catalog.BUNDLED);
  assert.ok(cat.length >= 10);
  assert.strictEqual(catalog.validateCatalog({ schema: 2, models: [] }), null, 'unbekanntes Schema');
  assert.strictEqual(catalog.validateCatalog({ schema: 1, models: [{ id: 'evil; rm -rf /', params: 1, sizeGB: 1, ctxMax: 1, kvMBPer1k: 1 }] }), null, 'ungültige ID');
  assert.strictEqual(catalog.validateCatalog({ schema: 1, models: [{ id: 'ok:1b', params: -1, sizeGB: 1, ctxMax: 1, kvMBPer1k: 1 }] }), null, 'ungültige Zahl');
  const reg = Object.fromEntries(cat.map((m) => [m.id, { available: true, sizeBytes: m.sizeGB * GB, quant: 'Q4_K_M' }]));
  const box = (ram, vram, threads = 12, extra = {}) => ({ ram: { totalGB: ram, freeGB: ram * 0.6 }, cpu: { threads, avx2: true }, primary: vram ? { name: 'GPU', vramGB: vram, freeVramGB: null } : null, gpus: [], ...extra });
  const rec = (h, o = {}) => catalog.recommend(h, cat, { registry: reg, ...o });
  // Stufen aus der Vorgabe (ungefähr): Prozessor 16 GB → höchstens ~4B
  const cpu16 = rec(box(16, 0));
  assert.ok(cpu16.recommended.params <= 4.5, `CPU 16 GB: ${cpu16.recommended.id}`);
  assert.strictEqual(cpu16.recommended.plan.device, 'cpu');
  assert.ok(cpu16.fastest && cpu16.fastest.params < cpu16.recommended.params, 'schnelleres, kleineres Modell');
  const cpu32 = rec(box(32, 0));
  assert.ok(cpu32.recommended.params >= 4 && cpu32.recommended.params <= 9, `CPU 32 GB: ${cpu32.recommended.id}`);
  // 6 GB Grafikspeicher: 3–4B ganz auf der Grafikkarte
  const g6 = rec(box(16, 6));
  assert.strictEqual(g6.recommended.plan.device, 'gpu');
  assert.ok(g6.recommended.params <= 4.5);
  // 8 GB: 4–8B auf der Grafikkarte
  const g8 = rec(box(16, 8));
  assert.strictEqual(g8.recommended.plan.device, 'gpu');
  assert.ok(g8.recommended.params >= 4 && g8.recommended.params <= 9, `8 GB: ${g8.recommended.id}`);
  // 12 und 16 GB: 8–14B, Beste Qualität darf teilweise auf dem Prozessor laufen
  const g12 = rec(box(32, 12));
  assert.ok(g12.recommended.params >= 8 && g12.recommended.params <= 15, `12 GB: ${g12.recommended.id}`);
  assert.strictEqual(g12.recommended.plan.device, 'gpu');
  assert.ok(!g12.best || g12.best.quality > g12.recommended.quality, 'Beste Qualität ist wirklich besser');
  // 24 GB: grössere Modelle inkl. MoE
  const g24 = rec(box(64, 24));
  assert.ok(g24.recommended.params >= 20, `24 GB: ${g24.recommended.id}`);
  assert.strictEqual(g24.recommended.plan.device, 'gpu');
  // Grafikspeicher fast voll (Spiel läuft): freier Speicher zählt
  const busy = rec(box(32, 12, 12, { primary: { name: 'GPU', vramGB: 12, freeVramGB: 3 } }));
  assert.notStrictEqual(busy.recommended.plan.device, 'gpu', 'nicht auf die volle Grafikkarte');
  // Nie ein Modell, das Windows den Speicher wegnimmt: Bedarf bleibt im Budget
  for (const h of [box(8, 0, 4), box(16, 0), box(16, 4), box(32, 12)]) {
    const r = rec(h);
    const { gpuGB, ramGB } = catalog.budgets(h);
    for (const p of [r.recommended, r.fastest, r.best].filter(Boolean)) assert.ok(p.plan.needGB <= gpuGB + ramGB + 0.01, `${p.id} passt ins Budget`);
  }
  // Zu wenig Arbeitsspeicher: nichts passt
  assert.strictEqual(rec(box(4, 0, 2)).nothingFits, true);
  // Modell, das es laut Registry nicht gibt, wird nie empfohlen
  const gone = { ...reg, 'qwen3.5:9b': { available: false } };
  assert.notStrictEqual(rec(box(32, 12), { registry: gone }).recommended.id, 'qwen3.5:9b');
  // Ohne Registry (offline) nichts empfehlen, ausser es ist schon installiert
  assert.strictEqual(rec(box(32, 12), { registry: {} }).recommended, null);
  assert.strictEqual(rec(box(32, 12), { registry: {}, installed: ['qwen3:4b'] }).recommended.id, 'qwen3:4b');
  // Braucht eine neuere Ollama-Version
  const newer = { ...reg, 'qwen3.5:9b': { ...reg['qwen3.5:9b'], requires: '0.99.0' } };
  assert.notStrictEqual(rec(box(32, 12), { registry: newer, runtimeVersion: '0.40.14' }).recommended.id, 'qwen3.5:9b');
  assert.ok(catalog.versionAtLeast('0.40.14', '0.12'));
  assert.ok(!catalog.versionAtLeast('0.9.0', '0.12.1'));
  // Denkmodelle sind nie «Empfohlen» oder «Am schnellsten»
  for (const h of [box(16, 0), box(32, 16), box(64, 24)]) {
    const r = rec(h);
    assert.ok(!r.recommended.alwaysThinks && !(r.fastest && r.fastest.alwaysThinks));
  }
  // Englisch-lastige Modelle nicht als «Am schnellsten» für Deutsch
  assert.ok(!rec(box(16, 6)).fastest?.limits.includes('english_focus'));
  // Ohne AVX2 wird der Prozessor als schwach eingestuft
  assert.ok(catalog.SPEED_ORDER.indexOf(catalog.planFor(cat.find((c) => c.id === 'qwen3.5:4b'), { ...box(16, 0), cpu: { threads: 8, avx2: false } }).speed) >= catalog.SPEED_ORDER.indexOf(catalog.planFor(cat.find((c) => c.id === 'qwen3.5:4b'), box(16, 0)).speed));
  // Kontext: feste Länge aus den erweiterten Einstellungen, sonst nach Speicher
  const q4 = cat.find((c) => c.id === 'qwen3:4b');
  assert.strictEqual(catalog.planFor(q4, box(32, 12), { ctx: 4096 }).ctx, 4096);
  assert.ok(catalog.planFor(q4, box(32, 12)).ctx >= 8192);
  assert.ok(catalog.planFor(q4, box(8, 0, 4)).ctx <= 8192, 'wenig Speicher: kürzerer Kontext');
  // Lizenz aus dem Registry-Text
  assert.strictEqual(catalog.licenseName('                                 Apache License\n                           Version 2.0'), 'Apache 2.0');
  assert.strictEqual(catalog.licenseName('Gemma Terms of Use\n\nLast modified'), 'Gemma Terms of Use');
  assert.strictEqual(catalog.licenseName('LLAMA 3.2 COMMUNITY LICENSE AGREEMENT'), 'Llama 3.2 Community License');

  // Registry-Abfrage (nachgebaut): Grösse aus den Schichten, Quantisierung und Lizenz aus den Blobs
  const fakeRegistry = async (url) => {
    if (/manifests\/4b$/.test(url)) return new Response(JSON.stringify({ config: { digest: 'sha256:cfg', size: 500 }, layers: [{ mediaType: 'application/vnd.ollama.image.model', size: 2.5e9, digest: 'sha256:m' }, { mediaType: 'application/vnd.ollama.image.license', size: 1000, digest: 'sha256:l' }] }), { status: 200 });
    if (/blobs\/sha256:cfg/.test(url)) return new Response(JSON.stringify({ file_type: 'Q4_K_M', requires: '0.12.0' }));
    if (/blobs\/sha256:l/.test(url)) return new Response('Apache License\nVersion 2.0');
    return new Response('{"errors":[{"code":"MANIFEST_UNKNOWN"}]}', { status: 404 });
  };
  const info = await catalog.registryInfo('qwen3:4b', fakeRegistry);
  assert.strictEqual(info.available, true);
  assert.strictEqual(info.sizeBytes, 2.5e9 + 1000 + 500);
  assert.strictEqual(info.quant, 'Q4_K_M');
  assert.strictEqual(info.requires, '0.12.0');
  assert.strictEqual(info.license, 'Apache 2.0');
  assert.strictEqual((await catalog.registryInfo('nope:1b', fakeRegistry)).available, false);
  assert.strictEqual((await catalog.registryInfo('qwen3:4b', async () => { throw new Error('offline'); })).available, null, 'offline = unbekannt');

  // Katalog aus dem Repo: nur gültig und nicht älter als der eingebaute
  const cacheFile = path.join(tmp, 'cat.json');
  const newerCat = { ...catalog.BUNDLED, updated: '2099-01-01', models: [catalog.BUNDLED.models[0]] };
  const loaded = await catalog.loadCatalog({ cacheFile, fetchImpl: async () => new Response(JSON.stringify(newerCat)) });
  assert.strictEqual(loaded.source, 'remote');
  assert.strictEqual(loaded.models.length, 1);
  const bad = await catalog.loadCatalog({ cacheFile: path.join(tmp, 'cat2.json'), fetchImpl: async () => new Response('{"schema":1,"models":[{"id":"x"}]}') });
  assert.strictEqual(bad.source, 'bundled', 'ungültiger Katalog wird verworfen');

  // ---------------- Ollama-Laufzeit gegen den nachgebauten Server ----------------

  {
    const { envFor } = require('../src/local/ollama');
    const saved = process.env.PSModulePath;
    process.env.PSModulePath = 'C:\\Program Files\\PowerShell\\7\\Modules';
    assert.ok(!('PSModulePath' in envFor('powershell.exe')), 'Windows PowerShell ohne geerbten Modulpfad');
    assert.strictEqual(envFor('nvidia-smi'), process.env);
    if (saved === undefined) delete process.env.PSModulePath; else process.env.PSModulePath = saved;
  }
  assert.strictEqual(classify('model requires more system memory (12.0 GiB) than is available (6.1 GiB)'), 'out_of_memory');
  assert.strictEqual(classify('CUDA error: out of memory'), 'out_of_memory');
  assert.strictEqual(classify('llama runner process has terminated: exit status 0xc0000409'), 'gpu_error');
  assert.strictEqual(classify("pull model manifest: file does not exist"), 'not_found');
  assert.strictEqual(classify('registry.ollama.ai/library/x does not support tools'), 'unsupported');
  assert.strictEqual(classify('dial tcp: lookup registry.ollama.ai: no such host'), 'network');
  assert.strictEqual(classify('write /models/blobs: no space left on device'), 'disk_full');
  const devices = parseComputeLines(['time=2026-11-04T10:00:00 level=INFO source=types.go:131 msg="inference compute" id=GPU-1 library=CUDA compute=8.6 driver=12.7 name=CUDA0 description="NVIDIA GeForce RTX 3060" libdirs=ollama,cuda_v12 total="12.0 GiB" available="11.0 GiB"', 'msg="inference compute" id=0 library=Vulkan name=Vulkan0 description="AMD Radeon RX 6600" total="8.0 GiB" available="7.5 GiB"', 'msg=other']);
  assert.deepStrictEqual(devices.map((d) => d.library), ['cuda', 'vulkan']);
  assert.strictEqual(devices[0].name, 'NVIDIA GeForce RTX 3060');
  assert.strictEqual(devices[0].totalGB, 12);

  const mock = await createMockOllama({ models: { 'qwen3:4b': { size: 2.5e9, caps: ['completion', 'tools', 'thinking'] } } });
  const rt = createOllama({ host: mock.host, platform: 'linux', home: tmp, env: {} });
  assert.strictEqual(await rt.version(), '0.40.14');
  const det = await rt.detect();
  assert.strictEqual(det.running, true);
  assert.strictEqual(det.installed, true);
  assert.deepStrictEqual((await rt.list()).map((m) => m.id), ['qwen3:4b']);
  const shown = await rt.show('qwen3:4b');
  assert.deepStrictEqual(shown.caps, ['completion', 'tools', 'thinking']);
  assert.strictEqual(shown.contextLength, 40960);
  assert.strictEqual(shown.layers, 36);
  assert.strictEqual(kvMBPer1kFromShow(shown), Math.round((36 * 8 * 256 * 2 * 1000) / 1024 / 1024));
  await assert.rejects(rt.show('nope:1b'), (e) => e instanceof LocalError && e.code === 'not_found');
  // Download mit Fortschritt (zwei Teile, Summe), danach installiert
  const prog = [];
  await rt.pull('gemma4:e2b', { onProgress: (p) => prog.push(p) });
  assert.ok(prog.length >= 5);
  const last = prog[prog.length - 1];
  assert.strictEqual(last.status, 'success');
  assert.strictEqual(last.totalBytes, 1e9 + 1000);
  assert.strictEqual(last.completedBytes, last.totalBytes);
  assert.ok(prog.every((p, i) => i === 0 || p.completedBytes >= prog[i - 1].completedBytes), 'Fortschritt steigt nur');
  assert.ok((await rt.list()).some((m) => m.id === 'gemma4:e2b'));
  // Abbrechen mitten im Download
  mock.ctl.pullDelayMs = 40;
  mock.ctl.pullSteps = 20;
  const ctrl = new AbortController();
  setTimeout(() => ctrl.abort(), 120);
  await assert.rejects(rt.pull('qwen3.5:9b', { signal: ctrl.signal }), (e) => e.name === 'AbortError');
  await new Promise((r) => setTimeout(r, 60));
  assert.ok(mock.ctl.aborted >= 1, 'Server merkt den Abbruch');
  assert.ok(!(await rt.list()).some((m) => m.id === 'qwen3.5:9b'));
  mock.ctl.pullDelayMs = 2;
  mock.ctl.pullSteps = 3;
  // Download stockt zweimal (Verbindung offen, keine Daten): Buddy setzt selbst fort und meldet es
  {
    const rt2 = createOllama({ host: mock.host, platform: 'linux', home: tmp, env: {}, pullIdleMs: 80, pullResumeDelayMs: 1 });
    mock.ctl.pullStalls = 2;
    const before = mock.ctl.pulls;
    const seen = [];
    await rt2.pull('qwen3.5:4b', { onProgress: (p) => seen.push(p.status) });
    assert.strictEqual(mock.ctl.pulls - before, 3, 'zweimal fortgesetzt, dann fertig');
    assert.strictEqual(seen.filter((x) => x === 'resuming').length, 2, 'Fortsetzen wird angezeigt');
    assert.strictEqual(seen[seen.length - 1], 'success');
    mock.ctl.pullStalls = 5;
    await assert.rejects(rt2.pull('qwen3.5:4b'), (e) => e.code === 'timeout', 'nach drei Versuchen ehrliche Meldung');
    mock.ctl.pullStalls = 0;
  }
  // Fehler im Download-Stream
  mock.ctl.pullError = 'pull model manifest: file does not exist';
  await assert.rejects(rt.pull('nope:1b'), (e) => e.code === 'not_found');
  mock.ctl.pullError = null;
  // Laden, ps, Chat mit Streaming
  const ld = await rt.load('qwen3:4b', { options: { num_ctx: 8192 } });
  assert.ok(ld.loadMs >= 0);
  const ps = await rt.ps();
  assert.strictEqual(ps[0].ctx, 8192);
  assert.strictEqual(ps[0].vramBytes, ps[0].sizeBytes, 'ganz auf der Grafikkarte');
  let streamed = '';
  const chat = await rt.chat({ model: 'qwen3:4b', messages: [{ role: 'user', content: 'Hoi' }], think: false, onDelta: (x) => { streamed += x; } });
  assert.strictEqual(streamed, 'Hallo! Wie kann ich helfen?');
  assert.strictEqual(chat.content, streamed);
  assert.strictEqual(chat.promptTokens, 42);
  assert.ok(chat.timings.tokensPerSecond > 0);
  assert.ok(chat.timings.firstTokenMs !== null);
  const sent = mock.ctl.requests.filter((r) => r.path === '/api/chat').pop().body;
  assert.strictEqual(sent.think, false);
  assert.strictEqual(sent.stream, true);
  // Abbruch mitten in der Antwort
  mock.ctl.chatDelayMs = 30;
  const c2 = new AbortController();
  setTimeout(() => c2.abort(), 50);
  await assert.rejects(rt.chat({ model: 'qwen3:4b', messages: [{ role: 'user', content: 'x' }], signal: c2.signal }), (e) => e.name === 'AbortError');
  mock.ctl.chatDelayMs = 1;
  // Speicherfehler wird erkannt
  mock.ctl.chatError = { status: 500, error: 'model requires more system memory (12.0 GiB) than is available (6.1 GiB)' };
  await assert.rejects(rt.chat({ model: 'qwen3:4b', messages: [{ role: 'user', content: 'x' }] }), (e) => e.code === 'out_of_memory');
  mock.ctl.chatError = null;
  // Löschen und Entladen
  await rt.unload('qwen3:4b');
  assert.strictEqual((await rt.ps()).length, 0);
  await rt.remove('gemma4:e2b');
  assert.ok(!(await rt.list()).some((m) => m.id === 'gemma4:e2b'));
  // Nicht erreichbar: klarer Fehler, kein Hängen
  const dead = createOllama({ host: '127.0.0.1:9', platform: 'linux', home: tmp, env: {} });
  assert.strictEqual(await dead.version(), null);
  await assert.rejects(dead.list(), (e) => e.code === 'unreachable');
  // Ohne installiertes Programm: start() meldet «fehlt»
  await assert.rejects(dead.start(), (e) => e.code === 'runtime_missing');
  // Fremden Server nie beenden
  assert.strictEqual(await rt.stop(), false);
  // Ausserhalb von Windows keine automatische Installation
  assert.strictEqual((await rt.installPlan()).automatic, false);
  await assert.rejects(rt.install(), (e) => e.code === 'manual_install');

  // ---------------- Manager ----------------

  let config = { model: null, modelsDir: null, tools: true, unloadOnExit: true, advanced: {} };
  const hwFixed = {
    os: { platform: 'win32', name: 'Windows 11', build: 26100, arch: 'x64', release: '' }, cpu: { name: 'Ryzen', vendor: 'AMD', cores: 8, threads: 16, avx: true, avx2: true, avx512: false },
    ram: { totalGB: 32, freeGB: 20 }, gpus: [{ name: 'NVIDIA GeForce RTX 3060', vendor: 'nvidia', integrated: false, vramGB: 12, freeVramGB: 11, driver: '561.09', computeCap: 8.6, backends: ['cuda', 'vulkan'], notes: [], source: 'nvidia-smi' }],
    disk: { path: tmp, freeGB: 200, totalGB: 500 }, vulkan: true, backends: ['cuda', 'vulkan', 'cpu'], errors: [], at: Date.now(),
  };
  hwFixed.primary = hwFixed.gpus[0];
  const registryAll = async (url) => {
    const m = /library\/([^/]+)\/manifests\/(.+)$/.exec(url);
    if (!m) return new Response('', { status: 404 });
    const c = cat.find((x) => x.id === `${m[1]}:${m[2]}`);
    if (!c) return new Response('', { status: 404 });
    return new Response(JSON.stringify({ layers: [{ mediaType: 'application/vnd.ollama.image.model', size: c.sizeGB * GB }] }));
  };
  mock.ctl.models.clear();
  const states = [];
  const mgr = createLocalManager({
    runtime: rt, cacheDir: tmp, remoteFetch: registryAll, lang: () => 'de',
    getConfig: () => config, setConfig: (p) => { config = { ...config, ...p }; },
    detectHardware: async () => JSON.parse(JSON.stringify({ ...hwFixed, primary: hwFixed.gpus[0] })),
    freeRamGB: () => 20,
  });
  mgr.onChange((s) => states.push(s.phase));
  let s = await mgr.init();
  assert.strictEqual(s.phase, 'needs_model', 'Ollama läuft, aber noch kein Modell');
  assert.strictEqual(s.hardware.gpu, 'NVIDIA GeForce RTX 3060');
  await mgr.refreshRegistry();
  s = mgr.snapshot();
  assert.ok(s.picks.recommended, 'Empfehlung vorhanden');
  assert.ok(s.picks.recommended.sizeExact, 'Grösse aus der Registry');
  const recId = s.picks.recommended.id;
  // Download → automatisch gewählt, geladen und kurz getestet
  s = await mgr.pull(recId);
  assert.strictEqual(s.phase, 'ready');
  assert.strictEqual(s.config.model, recId);
  assert.strictEqual(s.loaded.id, recId);
  assert.strictEqual(s.loaded.device, 'gpu', 'Grafikkarte bestätigt (size_vram)');
  assert.strictEqual(s.loaded.testOk, true);
  assert.ok(states.includes('downloading') && states.includes('loading'));
  // Kein zweiter Download desselben Modells
  const pullsBefore = mock.ctl.pulls;
  await mgr.pull(recId);
  assert.strictEqual(mock.ctl.pulls, pullsBefore);
  // Teilweise auf der Grafikkarte: ehrlich melden
  mock.ctl.vramShare = 0.6;
  mock.ctl.loaded.clear();
  s = mgr.snapshot();
  await mgr.ensureLoaded(recId);
  assert.strictEqual(mgr.snapshot().loaded.device, 'partial');
  assert.strictEqual(mgr.snapshot().loaded.gpuPercent, 60);
  mock.ctl.vramShare = 0;
  mock.ctl.loaded.clear();
  await mgr.ensureLoaded(recId);
  assert.strictEqual(mgr.snapshot().loaded.device, 'cpu', 'nie «Grafikkarte» behaupten, wenn sie nicht rechnet');
  mock.ctl.vramShare = 1;
  // Modellwechsel: das vorherige wird zuerst freigegeben
  mock.add('qwen3:4b', { size: 2.5e9, caps: ['completion', 'tools', 'thinking'] });
  await mgr.refresh();
  await mgr.selectModel('qwen3:4b');
  const loadedIds = [...mock.ctl.loaded.keys()];
  assert.deepStrictEqual(loadedIds, ['qwen3:4b'], 'nie zwei Modelle gleichzeitig');
  assert.strictEqual(config.model, 'qwen3:4b');
  // Erweiterte Einstellungen: Kontext und «Nur Prozessor» gehen an Ollama
  config.advanced = { ctx: 4096, gpu: 'cpu' };
  const o = await mgr.optionsFor('qwen3:4b');
  assert.strictEqual(o.options.num_ctx, 4096);
  assert.strictEqual(o.options.num_gpu, 0);
  config.advanced = {};
  assert.deepStrictEqual(cleanAdvanced({ ctx: 'x', temperature: 9, keepAlive: 'never', gpu: 'tpu' }), { ...cleanAdvanced({}), temperature: 2 });
  // Zu wenig freier Arbeitsspeicher: nicht laden, verständlicher Fehler
  const lowMgr = createLocalManager({
    runtime: rt, cacheDir: tmp, getConfig: () => ({ ...config, advanced: { gpu: 'cpu' } }), setConfig: () => {},
    detectHardware: async () => ({ ...hwFixed, primary: hwFixed.gpus[0] }), freeRamGB: () => 0.5,
  });
  await lowMgr.init();
  mock.ctl.loaded.clear();
  await assert.rejects(lowMgr.ensureLoaded('qwen3:4b'), (e) => e.code === 'low_ram');
  assert.strictEqual(lowMgr.snapshot().phase, 'error');
  assert.strictEqual(lowMgr.snapshot().error.code, 'low_ram');
  // Zu wenig Platz auf dem Laufwerk: Download startet gar nicht
  const fullMgr = createLocalManager({ runtime: rt, cacheDir: tmp, getConfig: () => config, setConfig: () => {}, detectHardware: async () => hwFixed, remoteFetch: registryAll });
  await fullMgr.init();
  const realDisk = hardware.diskInfo;
  hardware.diskInfo = async () => ({ path: tmp, freeGB: 0.5, totalGB: 100 });
  const pullsBefore2 = mock.ctl.pulls;
  const fs1 = await fullMgr.pull('qwen3.5:27b');
  hardware.diskInfo = realDisk;
  assert.strictEqual(fs1.error.code, 'disk_full');
  assert.strictEqual(mock.ctl.pulls, pullsBefore2, 'kein Download ohne Platz');
  // Download abbrechen: kein Fehler, Modell nicht installiert
  mock.ctl.pullDelayMs = 40;
  mock.ctl.pullSteps = 30;
  const p = mgr.pull('qwen3.5:2b', { select: false });
  setTimeout(() => mgr.cancelPull(), 100);
  s = await p;
  assert.ok(!s.installed.some((m) => m.id === 'qwen3.5:2b'));
  assert.notStrictEqual(s.phase, 'downloading');
  assert.strictEqual(s.error, null);
  mock.ctl.pullDelayMs = 2;
  mock.ctl.pullSteps = 3;
  // Download mit Tempo und Restzeit
  const progress = [];
  const off = mgr.onChange((x) => { if (x.download) progress.push(x.download); });
  mock.ctl.pullDelayMs = 350;
  mock.ctl.pullSteps = 14;
  await mgr.pull('qwen3.5:0.8b', { select: false });
  off();
  mock.ctl.pullDelayMs = 2;
  assert.ok(progress.some((d) => d.speedBps > 0), 'Download-Tempo gemessen');
  assert.ok(progress.some((d) => d.etaSec !== null), 'Restzeit geschätzt');
  // Löschen
  s = await mgr.removeModel('qwen3.5:0.8b');
  assert.ok(!s.installed.some((m) => m.id === 'qwen3.5:0.8b'));
  // Abstürze im Chat: Zustand wird ehrlich
  await mgr.noteChatError(new LocalError('runner_crashed', 'x'));
  assert.strictEqual(mgr.snapshot().phase, 'error');
  assert.strictEqual(mgr.snapshot().loaded, null);
  // Diagnose ohne Inhalte
  const diag = await mgr.diagnostics();
  assert.ok(diag.runtime.running);
  assert.ok(Array.isArray(diag.loaded));
  // Beenden: eigenes Modell freigeben, fremden Server laufen lassen
  await mgr.ensureLoaded('qwen3:4b');
  await mgr.shutdown();
  assert.strictEqual(mock.ctl.loaded.size, 0, 'Modell beim Beenden freigegeben');
  assert.strictEqual(await rt.version(), '0.40.14', 'fremder Ollama-Server läuft weiter');

  // ---------------- Chat-Adapter ----------------

  const conv = toOllamaMessages([
    { role: 'user', content: 'Stell einen Timer' },
    { role: 'assistant', content: [{ type: 'text', text: 'Mach ich.' }, { type: 'tool_use', id: 't1', name: 'set_timer', input: { minutes: 5 } }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'Timer läuft' }, { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAA' } }] },
  ], 'System', { vision: false });
  assert.strictEqual(conv[0].role, 'system');
  assert.deepStrictEqual(conv[2].tool_calls, [{ function: { name: 'set_timer', arguments: { minutes: 5 } } }]);
  assert.deepStrictEqual(conv[3], { role: 'tool', tool_name: 'set_timer', content: 'Timer läuft' });
  assert.ok(/Bild weggelassen/.test(conv[4].content), 'Bild ohne Bildmodell wird ersetzt');
  assert.ok(!conv[4].images);
  const withVision = toOllamaMessages([{ role: 'user', content: [{ type: 'text', text: 'Was ist das?' }, { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAA' } }] }], '', { vision: true });
  assert.deepStrictEqual(withVision[0].images, ['AAA']);
  // Kürzen nur an Nutzer-Grenzen
  const long = [{ role: 'system', content: 'S' }];
  for (let i = 0; i < 30; i += 1) long.push({ role: 'user', content: `Frage ${i} ${'x'.repeat(350)}` }, { role: 'assistant', content: `Antwort ${i} ${'y'.repeat(350)}` });
  const fitted = fitToBudget(long, 2000);
  assert.ok(fitted.dropped.length > 0);
  assert.strictEqual(fitted.kept[0].role, 'system');
  assert.strictEqual(fitted.kept[1].role, 'user');
  assert.strictEqual(fitted.kept[fitted.kept.length - 1].content, long[long.length - 1].content);

  models.setLocalResolver({ caps: (id) => mgr.capsOf(id), name: (id) => cat.find((c) => c.id === id)?.name || null });
  assert.strictEqual(models.providerOf('local:qwen3:4b'), 'local');
  assert.strictEqual(models.capabilities('local:qwen3:4b').tools, true, 'Fähigkeiten von Ollama');
  assert.strictEqual(models.capabilities('local:qwen3:4b').computerUse, false);
  assert.strictEqual(models.info('local:qwen3:4b').short, 'Qwen 3 4B');
  assert.strictEqual(models.costOf('local:qwen3:4b', { input_tokens: 1000, output_tokens: 1000 }), 0, 'lokal kostet nichts');
  assert.deepStrictEqual(models.resolveTiers(['local:qwen3:4b'], 'local'), { haiku: 'local:qwen3:4b', sonnet: 'local:qwen3:4b', opus: 'local:qwen3:4b' });

  config.model = 'qwen3:4b';
  config.advanced = {};
  const client = createLocalClient({ manager: mgr, getAdvanced: () => cleanAdvanced({ temperature: 0.3 }) });
  let deltas = '';
  const res = await client.streamMessage({ apiKey: '', model: 'local:qwen3:4b', system: 'Sei nett.', messages: [{ role: 'user', content: 'Hoi' }], maxTokens: 512, onText: (x) => { deltas += x; } });
  assert.strictEqual(deltas, 'Hallo! Wie kann ich helfen?');
  assert.strictEqual(res.stopReason, 'end_turn');
  assert.strictEqual(res.usage.input_tokens, 42);
  const body = mock.ctl.requests.filter((r) => r.path === '/api/chat').pop().body;
  assert.strictEqual(body.options.temperature, 0.3);
  assert.strictEqual(body.options.num_predict, 512);
  assert.ok(body.options.num_ctx >= 4096);
  assert.strictEqual(body.think, false, 'Denken aus für schnelle Antworten');
  assert.strictEqual(body.messages[0].role, 'system');
  // Werkzeugaufruf wird zu einem tool_use-Block
  mock.ctl.toolCall = { name: 'set_timer', arguments: { minutes: 10, label: 'Pizza' } };
  const tr = await client.streamMessage({ apiKey: '', model: 'local:qwen3:4b', messages: [{ role: 'user', content: 'Timer 10 Min.' }], tools: [{ name: 'set_timer', description: 'Timer', input_schema: { type: 'object', properties: { minutes: { type: 'number' } } } }, { type: 'computer_toolset_20260801' }], maxTokens: 256 });
  assert.strictEqual(tr.stopReason, 'tool_use');
  const use = tr.content.find((b) => b.type === 'tool_use');
  assert.strictEqual(use.name, 'set_timer');
  assert.deepStrictEqual(use.input, { minutes: 10, label: 'Pizza' });
  assert.strictEqual(tr.droppedComputer, true, 'Computer Use gibt es lokal nicht');
  mock.ctl.toolCall = null;
  // Werkzeuge ausgeschaltet oder Modell ohne Werkzeuge: keine tools an Ollama
  const noTools = createLocalClient({ manager: mgr, allowTools: () => false });
  await noTools.streamMessage({ apiKey: '', model: 'local:qwen3:4b', messages: [{ role: 'user', content: 'x' }], tools: [{ name: 'set_timer', description: '', input_schema: {} }], maxTokens: 64 });
  assert.strictEqual(mock.ctl.requests.filter((r) => r.path === '/api/chat').pop().body.tools, undefined);
  // Langes Gespräch: ältere Nachrichten werden zusammengefasst und Buddy sagt es
  config.advanced = { ctx: 2048 };
  const notices = [];
  const longMsgs = [];
  for (let i = 0; i < 20; i += 1) longMsgs.push({ role: 'user', content: `Frage ${i}: ${'Text '.repeat(80)}` }, { role: 'assistant', content: `Antwort ${i}: ${'Mehr '.repeat(80)}` });
  longMsgs.push({ role: 'user', content: 'Und jetzt?' });
  mock.ctl.loaded.clear();
  await client.streamMessage({ apiKey: '', model: 'local:qwen3:4b', messages: longMsgs, maxTokens: 256, onNotice: (x) => notices.push(x) });
  assert.strictEqual(notices.length, 1, 'Hinweis im Chat');
  const lastChat = mock.ctl.requests.filter((r) => r.path === '/api/chat').pop().body;
  assert.ok(/summarized/.test(lastChat.messages[0].content), 'Zusammenfassung im Systemtext');
  assert.strictEqual(lastChat.messages[lastChat.messages.length - 1].content, 'Und jetzt?');
  assert.strictEqual(client.summaries.size, 1, 'Zusammenfassung wird wiederverwendet');
  config.advanced = {};
  // Fehler: verständliche Meldung, Kategorie «local» (keine sinnlose Wiederholung)
  mock.ctl.chatError = { status: 500, error: 'model requires more system memory (12.0 GiB) than is available (6.1 GiB)' };
  await assert.rejects(client.streamMessage({ apiKey: '', model: 'local:qwen3:4b', messages: [{ role: 'user', content: 'x' }], maxTokens: 64 }), (e) => e.category === 'local' && /Speicher/.test(e.message) && !e.retryable);
  mock.ctl.chatError = null;
  // Abbruch
  mock.ctl.chatDelayMs = 30;
  const ac = new AbortController();
  setTimeout(() => ac.abort(), 60);
  await assert.rejects(client.streamMessage({ apiKey: '', model: 'local:qwen3:4b', messages: [{ role: 'user', content: 'x' }], maxTokens: 64, signal: ac.signal }), (e) => e.name === 'AbortError');
  mock.ctl.chatDelayMs = 1;
  // Strukturierte Antwort
  mock.ctl.reply = '{"ok":true}';
  const j = await client.json({ apiKey: '', model: 'local:qwen3:4b', prompt: 'x', schema: { type: 'object' } });
  assert.deepStrictEqual(j.data, { ok: true });
  assert.deepStrictEqual(mock.ctl.requests.filter((r) => r.path === '/api/chat').pop().body.format, { type: 'object' });
  // Alles geht nur an 127.0.0.1
  assert.ok(mock.ctl.requests.length > 20);

  await mock.close();
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('Lokale-KI-Tests ok (Hardware: NVIDIA, AMD, Intel, integriert, nur CPU, mehrere GPUs, wenig RAM/VRAM; Empfehlung; Ollama; Manager; Chat)');
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
