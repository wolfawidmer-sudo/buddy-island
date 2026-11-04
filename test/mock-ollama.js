// Nachgebauter Ollama-Server für Tests (gleiche Endpunkte und Antwortformate wie Ollama:
// /api/version, /api/tags, /api/ps, /api/show, /api/pull (NDJSON-Fortschritt), /api/delete,
// /api/generate (Laden/Entladen), /api/chat (NDJSON-Stream, Werkzeugaufrufe)).
// Das Verhalten lässt sich pro Test über `ctl` steuern.
const http = require('http');

function createMockOllama(opts = {}) {
  const ctl = {
    version: opts.version || '0.40.14',
    models: new Map(), // id -> { size, caps, ctx, arch }
    loaded: new Map(), // id -> { size, vram, ctx }
    vramShare: opts.vramShare ?? 1, // Anteil auf der Grafikkarte nach dem Laden
    pullDelayMs: opts.pullDelayMs ?? 5,
    pullSteps: opts.pullSteps ?? 5,
    pullError: null, // z. B. 'pull model manifest: file does not exist'
    chatError: null, // z. B. { status: 500, error: 'model requires more system memory (12.0 GiB) than is available (6.0 GiB)' }
    loadError: null,
    reply: opts.reply || 'Hallo! Wie kann ich helfen?',
    toolCall: null, // { name, arguments }
    chatDelayMs: opts.chatDelayMs ?? 2,
    requests: [], // { path, body }
    pulls: 0,
    aborted: 0,
  };
  const add = (id, info = {}) => ctl.models.set(id, { size: info.size || 2.5e9, caps: info.caps || ['completion', 'tools'], ctx: info.ctx || 40960, arch: info.arch || { block_count: 36, 'attention.head_count_kv': 8, 'attention.key_length': 128, 'attention.head_count': 32, embedding_length: 4096 } });
  for (const [id, info] of Object.entries(opts.models || {})) add(id, info);

  const json = (res, status, obj) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (d) => { raw += d; });
    req.on('end', async () => {
      let body = {};
      try { body = raw ? JSON.parse(raw) : {}; } catch { body = {}; }
      ctl.requests.push({ path: req.url, method: req.method, body });
      const model = body.model || body.name;
      try {
        if (req.url === '/api/version') return json(res, 200, { version: ctl.version });
        if (req.url === '/api/tags') return json(res, 200, { models: [...ctl.models].map(([id, m]) => ({ name: id, model: id, size: m.size, digest: `sha256:${id.length}`, modified_at: '2026-11-01T10:00:00Z', details: { family: id.split(':')[0], parameter_size: '4B', quantization_level: 'Q4_K_M' } })) });
        if (req.url === '/api/ps') return json(res, 200, { models: [...ctl.loaded].map(([id, m]) => ({ name: id, model: id, size: m.size, size_vram: m.vram, context_length: m.ctx, expires_at: '2026-11-04T13:00:00Z' })) });
        if (req.url === '/api/show') {
          const m = ctl.models.get(model);
          if (!m) return json(res, 404, { error: `model '${model}' not found` });
          const arch = 'qwen3';
          const info = { 'general.architecture': arch, 'general.parameter_count': 4e9, [`${arch}.context_length`]: m.ctx };
          for (const [k, v] of Object.entries(m.arch)) info[`${arch}.${k}`] = v;
          return json(res, 200, { capabilities: m.caps, details: { family: arch, parameter_size: '4.0B', quantization_level: 'Q4_K_M' }, model_info: info, license: 'Apache License 2.0' });
        }
        if (req.url === '/api/delete') {
          if (!ctl.models.delete(model)) return json(res, 404, { error: `model '${model}' not found` });
          ctl.loaded.delete(model);
          return json(res, 200, {});
        }
        if (req.url === '/api/pull') {
          ctl.pulls += 1;
          res.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
          let closed = false;
          res.on('close', () => { if (!res.writableEnded) { closed = true; ctl.aborted += 1; } });
          const w = (o) => { if (!closed) res.write(`${JSON.stringify(o)}\n`); };
          w({ status: 'pulling manifest' });
          if (ctl.pullError) { w({ error: ctl.pullError }); return res.end(); }
          const total = 1e9;
          for (let i = 1; i <= ctl.pullSteps; i += 1) {
            await sleep(ctl.pullDelayMs);
            if (closed) return;
            w({ status: 'pulling abc', digest: 'sha256:abc', total, completed: Math.round((total * i) / ctl.pullSteps) });
          }
          w({ status: 'pulling def', digest: 'sha256:def', total: 1000, completed: 1000 });
          w({ status: 'verifying sha256 digest' });
          w({ status: 'writing manifest' });
          add(model, opts.pullInfo || {});
          w({ status: 'success' });
          return res.end();
        }
        if (req.url === '/api/generate') {
          const m = ctl.models.get(model);
          if (!m) return json(res, 404, { error: `model '${model}' not found` });
          if (body.keep_alive === 0) { ctl.loaded.delete(model); return json(res, 200, { model, done: true, done_reason: 'unload' }); }
          if (ctl.loadError) return json(res, 500, { error: ctl.loadError });
          ctl.loaded.set(model, { size: m.size * 1.2, vram: Math.round(m.size * 1.2 * ctl.vramShare), ctx: body.options?.num_ctx || 4096 });
          return json(res, 200, { model, done: true, done_reason: 'load', load_duration: 1.5e9 });
        }
        if (req.url === '/api/chat') {
          const m = ctl.models.get(model);
          if (!m) return json(res, 404, { error: `model '${model}' not found` });
          if (ctl.chatError) return json(res, ctl.chatError.status || 500, { error: ctl.chatError.error });
          if (body.tools && !m.caps.includes('tools')) return json(res, 400, { error: `registry.ollama.ai/library/${model} does not support tools` });
          if (body.think === true && !m.caps.includes('thinking')) return json(res, 400, { error: `"${model}" does not support thinking` });
          if (!ctl.loaded.has(model)) ctl.loaded.set(model, { size: m.size * 1.2, vram: Math.round(m.size * 1.2 * ctl.vramShare), ctx: body.options?.num_ctx || 4096 });
          res.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
          let closed = false;
          res.on('close', () => { if (!res.writableEnded) { closed = true; ctl.aborted += 1; } });
          const lastUser = [...(body.messages || [])].reverse().find((x) => x.role === 'user')?.content || '';
          const text = /Reply with: OK/.test(lastUser) ? 'OK' : ctl.reply;
          if (ctl.toolCall && body.tools && !(body.messages || []).some((x) => x.role === 'tool')) {
            res.write(`${JSON.stringify({ model, message: { role: 'assistant', content: '', tool_calls: [{ function: ctl.toolCall }] }, done: false })}\n`);
          } else {
            for (const piece of text.match(/.{1,4}/gs) || []) {
              await sleep(ctl.chatDelayMs);
              if (closed) return;
              res.write(`${JSON.stringify({ model, message: { role: 'assistant', content: piece }, done: false })}\n`);
            }
          }
          const n = Math.ceil(text.length / 4);
          res.write(`${JSON.stringify({ model, message: { role: 'assistant', content: '' }, done: true, done_reason: 'stop', total_duration: 9e8, load_duration: 1e6, prompt_eval_count: 42, prompt_eval_duration: 1e8, eval_count: n, eval_duration: n * 2e7 })}\n`);
          return res.end();
        }
        json(res, 404, { error: 'not found' });
      } catch (err) {
        json(res, 500, { error: String(err.message) });
      }
    });
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({ ctl, add, host: `127.0.0.1:${port}`, close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(() => r()); }) });
    });
  });
}

module.exports = { createMockOllama };
