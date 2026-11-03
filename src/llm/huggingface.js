// @ts-check
// Lokale Open-Source-Modelle ausschliesslich über Hugging Face:
// `transformers` (AutoTokenizer, AutoModelForCausalLM, Chat-Vorlage, TextIteratorStreamer)
// und `huggingface_hub` (Download in den HF-Cache, optional mit Token für geschützte Modelle).
// Ein kleiner Python-Helfer lädt das Modell einmal und beantwortet dann Anfragen über
// JSON-Zeilen (stdin/stdout). Nach 10 Minuten ohne Anfrage beendet er sich und gibt
// Arbeitsspeicher und Grafikspeicher wieder frei.

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { ProviderError, abortError } = require('./errors');
const models = require('../models');
const { t } = require('../i18n');

/** @typedef {import('./types').LlmClient} LlmClient */
/** @typedef {import('./types').Message} Message */
/** @typedef {{ exe: string, args: string[] }} PythonRuntime */

const IDLE_STOP_MS = 10 * 60 * 1000;
const LOAD_TIMEOUT_MS = 30 * 60 * 1000; // erster Start lädt das Modell evtl. herunter
const NAME = 'Hugging Face';

const HELPER_SCRIPT = String.raw`# Buddy Island: lokales Hugging-Face-Modell
import sys, json, threading, os
lock = threading.Lock()
gen_lock = threading.Lock()
def out(obj):
    with lock:
        sys.stdout.write(json.dumps(obj, ensure_ascii=False) + "\n")
        sys.stdout.flush()
try:
    import torch
    from transformers import AutoTokenizer, AutoModelForCausalLM, TextIteratorStreamer, StoppingCriteria, StoppingCriteriaList
except Exception as e:
    out({"type": "fatal", "error": "missing:" + str(e)[:300]})
    sys.exit(1)
model_id = sys.argv[1]
token = os.environ.get("HF_TOKEN") or None
try:
    tok = AutoTokenizer.from_pretrained(model_id, token=token)
    if torch.cuda.is_available():
        device = "cuda"
    elif getattr(torch.backends, "mps", None) is not None and torch.backends.mps.is_available():
        device = "mps"
    else:
        device = "cpu"
    model = AutoModelForCausalLM.from_pretrained(model_id, token=token, torch_dtype="auto")
    model.to(device)
    model.eval()
except Exception as e:
    out({"type": "fatal", "error": str(e)[:500]})
    sys.exit(1)
out({"type": "ready", "device": device})
cancels = set()
class Stop(StoppingCriteria):
    def __init__(self, rid):
        self.rid = rid
    def __call__(self, input_ids, scores, **kw):
        return self.rid in cancels
def encode(msgs):
    try:
        return tok.apply_chat_template(msgs, add_generation_prompt=True, return_tensors="pt", return_dict=True)
    except Exception:
        # Vorlagen ohne System-Rolle: System-Text in die erste Nutzer-Nachricht
        sys_txt = "\n".join(m["content"] for m in msgs if m["role"] == "system")
        rest = [dict(m) for m in msgs if m["role"] != "system"]
        if sys_txt and rest:
            rest[0]["content"] = sys_txt + "\n\n" + rest[0]["content"]
        return tok.apply_chat_template(rest, add_generation_prompt=True, return_tensors="pt", return_dict=True)
def run(req):
    rid = req["id"]
    with gen_lock:
        try:
            enc = {k: v.to(device) for k, v in encode(req["messages"]).items()}
            streamer = TextIteratorStreamer(tok, skip_prompt=True, skip_special_tokens=True)
            kwargs = dict(enc, max_new_tokens=int(req.get("max_tokens", 1024)), streamer=streamer,
                          stopping_criteria=StoppingCriteriaList([Stop(rid)]))
            temp = float(req.get("temperature", 0.7))
            if temp > 0:
                kwargs.update(do_sample=True, temperature=temp, top_p=0.95)
            else:
                kwargs.update(do_sample=False)
            if tok.pad_token_id is None:
                kwargs["pad_token_id"] = tok.eos_token_id
            th = threading.Thread(target=model.generate, kwargs=kwargs, daemon=True)
            th.start()
            n = 0
            for piece in streamer:
                if piece:
                    n += len(tok.encode(piece, add_special_tokens=False))
                    out({"type": "delta", "id": rid, "text": piece})
            th.join()
            out({"type": "done", "id": rid, "input_tokens": int(enc["input_ids"].shape[-1]), "output_tokens": n, "cancelled": rid in cancels})
        except Exception as e:
            out({"type": "error", "id": rid, "error": str(e)[:500]})
        finally:
            cancels.discard(rid)
for line in sys.stdin:
    try:
        req = json.loads(line)
    except Exception:
        continue
    if req.get("type") == "cancel":
        cancels.add(req.get("id"))
        continue
    if req.get("type") == "quit":
        break
    threading.Thread(target=run, args=(req,), daemon=True).start()
`;

/**
 * Buddys Nachrichten → einfache Chat-Nachrichten (nur Text).
 * @param {Message[]} messages @param {string|undefined} system
 */
function toPlainMessages(messages, system) {
  /** @type {{role: string, content: string}[]} */
  const out = [];
  if (system && system.trim()) out.push({ role: 'system', content: system.trim() });
  for (const m of messages) {
    let text;
    if (typeof m.content === 'string') text = m.content;
    else {
      text = m.content.map((b) => {
        if (b.type === 'text') return b.text;
        if (b.type === 'image') return t('[Bild weggelassen: dieses Modell kann keine Bilder sehen]');
        if (b.type === 'tool_result') return typeof b.content === 'string' ? b.content : b.content.filter((x) => x.type === 'text').map((x) => /** @type {any} */ (x).text).join('\n');
        return '';
      }).filter(Boolean).join('\n\n');
    }
    if (!text) continue;
    // Gleiche Rollen nacheinander zusammenfassen (manche Vorlagen verlangen Wechsel)
    const prev = out[out.length - 1];
    if (prev && prev.role === m.role) prev.content += `\n\n${text}`;
    else out.push({ role: m.role, content: text });
  }
  return out;
}

/**
 * @param {{ scriptDir: string, getRuntime: () => Promise<PythonRuntime|null>, getToken?: () => string|null, log?: (m: string) => void, spawnImpl?: typeof spawn, onStatus?: (s: {state: string, model: string|null, device: string|null, error: string|null}) => void }} opts
 * @returns {LlmClient & { status: () => {state: string, model: string|null, device: string|null, error: string|null}, preload: (model: string) => Promise<void> }}
 */
function createHuggingFaceClient({ scriptDir, getRuntime, getToken = () => null, log = () => {}, spawnImpl = spawn, onStatus = () => {} }) {
  /** @type {null | { model: string, proc: import('child_process').ChildProcess, ready: Promise<void>, pending: Map<string, any>, buffer: string, idle?: ReturnType<typeof setTimeout> }} */
  let helper = null;
  let stateValue = 'stopped';
  const emit = () => { try { onStatus({ state: stateValue, model: helper?.model || null, device, error: lastError }); } catch { /* egal */ } };
  const setState = (/** @type {string} */ v) => { stateValue = v; emit(); };
  /** @type {string|null} */
  let device = null;
  /** @type {string|null} */
  let lastError = null;

  function stop() {
    if (!helper) return;
    const h = helper;
    helper = null;
    setState('stopped');
    clearTimeout(h.idle);
    for (const p of h.pending.values()) p.reject(new ProviderError(0, t('Das lokale Modell wurde beendet.'), 'local_error', NAME));
    try { h.proc.stdin?.write('{"type":"quit"}\n'); } catch { /* egal */ }
    setTimeout(() => { try { h.proc.kill(); } catch { /* schon weg */ } }, 1500);
  }

  function touch() {
    if (!helper) return;
    clearTimeout(helper.idle);
    helper.idle = setTimeout(() => { if (helper && !helper.pending.size) { log('Hugging Face: Modell nach Leerlauf entladen'); stop(); } }, IDLE_STOP_MS);
  }

  /** @param {string} modelPath */
  async function ensure(modelPath) {
    if (helper && helper.model === modelPath) return helper.ready;
    stop();
    const runtime = await getRuntime();
    if (!runtime) throw new ProviderError(0, t('Die lokale KI ist noch nicht fertig eingerichtet. Tippe auf «Lokale KI einrichten», Buddy macht dort weiter, wo er aufgehört hat.'), 'local_error', NAME);
    fs.mkdirSync(scriptDir, { recursive: true });
    const file = path.join(scriptDir, 'buddy-hf.py');
    fs.writeFileSync(file, HELPER_SCRIPT, 'utf8');
    /** @type {NodeJS.ProcessEnv} */
    const env = { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUNBUFFERED: '1', TOKENIZERS_PARALLELISM: 'false' };
    const token = getToken();
    if (token) env.HF_TOKEN = token;
    const proc = spawnImpl(runtime.exe, [...runtime.args, file, modelPath], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, env });
    lastError = null;
    /** @type {NonNullable<typeof helper>} */
    const h = { model: modelPath, proc, pending: new Map(), buffer: '', ready: Promise.resolve() };
    helper = h;
    setState('loading');
    let errText = '';
    h.ready = new Promise((resolve, reject) => {
      const timer = setTimeout(() => { reject(new ProviderError(0, t('Das lokale Modell lädt zu lange.'), 'local_error', NAME)); stop(); }, LOAD_TIMEOUT_MS);
      proc.stdout?.setEncoding('utf8');
      proc.stdout?.on('data', (chunk) => {
        h.buffer += chunk;
        let nl;
        while ((nl = h.buffer.indexOf('\n')) !== -1) {
          const line = h.buffer.slice(0, nl).trim();
          h.buffer = h.buffer.slice(nl + 1);
          if (!line) continue;
          let msg;
          try { msg = JSON.parse(line); } catch { continue; }
          if (msg.type === 'ready') {
            clearTimeout(timer);
            device = msg.device;
            setState('ready');
            log(`Hugging Face: ${modelPath} geladen (${msg.device})`);
            resolve();
            touch();
          } else if (msg.type === 'fatal') {
            clearTimeout(timer);
            const missing = String(msg.error).startsWith('missing:');
            lastError = missing ? t('Python-Pakete «transformers» und «torch» fehlen.') : String(msg.error);
            setState('error');
            reject(new ProviderError(0, missing ? t('Die lokale KI ist noch nicht fertig eingerichtet. Tippe auf «Lokale KI einrichten», Buddy macht dort weiter, wo er aufgehört hat.') : t('Das Modell «{model}» konnte nicht geladen werden: {error}', { model: modelPath, error: String(msg.error).slice(0, 200) }), 'local_error', NAME));
          } else {
            const p = h.pending.get(msg.id);
            if (!p) continue;
            if (msg.type === 'delta') p.onText?.(msg.text);
            else if (msg.type === 'done') { h.pending.delete(msg.id); p.resolve(msg); touch(); }
            else if (msg.type === 'error') { h.pending.delete(msg.id); p.reject(new ProviderError(0, String(msg.error), 'local_error', NAME)); touch(); }
          }
        }
      });
      proc.stderr?.setEncoding('utf8');
      proc.stderr?.on('data', (d) => { errText = (errText + d).slice(-2000); });
      proc.on('error', (err) => {
        clearTimeout(timer);
        lastError = err.message;
        setState('error');
        reject(new ProviderError(0, t('Python konnte nicht gestartet werden.'), 'local_error', NAME));
      });
      proc.on('exit', (code) => {
        clearTimeout(timer);
        if (helper === h) { helper = null; setState(stateValue === 'error' ? 'error' : 'stopped'); }
        const err = new ProviderError(0, t('Das lokale Modell wurde beendet.'), 'local_error', NAME);
        for (const p of h.pending.values()) p.reject(err);
        h.pending.clear();
        if (code && code !== 0) log(`Hugging Face beendet (${code}): ${errText.slice(-300)}`);
        reject(err);
      });
    });
    return h.ready;
  }

  /** @param {import('./types').StreamRequest} req */
  async function streamMessage(req) {
    const modelPath = String(req.model || '').replace(/^hf:/, '');
    if (!modelPath) throw new ProviderError(0, t('Kein lokales Modell gewählt. Trag in den Einstellungen eine Hugging-Face-Modell-ID oder einen Ordner ein.'), 'local_error', NAME);
    if (req.signal?.aborted) throw abortError();
    await ensure(modelPath);
    const h = helper;
    if (!h) throw new ProviderError(0, t('Das lokale Modell wurde beendet.'), 'local_error', NAME);
    const id = Math.random().toString(36).slice(2, 10);
    const messages = toPlainMessages(req.messages, req.system);
    let text = '';
    const result = await new Promise((resolve, reject) => {
      const onAbort = () => {
        try { h.proc.stdin?.write(`${JSON.stringify({ type: 'cancel', id })}\n`); } catch { /* egal */ }
        h.pending.delete(id);
        reject(abortError());
      };
      req.signal?.addEventListener('abort', onAbort, { once: true });
      h.pending.set(id, {
        onText: (/** @type {string} */ piece) => { text += piece; req.onText?.(piece); },
        resolve: (/** @type {any} */ v) => { req.signal?.removeEventListener('abort', onAbort); resolve(v); },
        reject: (/** @type {any} */ e) => { req.signal?.removeEventListener('abort', onAbort); reject(e); },
      });
      h.proc.stdin?.write(`${JSON.stringify({ id, messages, max_tokens: Math.min(4096, req.maxTokens || 1024), temperature: req.format ? 0 : 0.7 })}\n`);
    });
    /** @type {import('./types').StreamResult} */
    const out = {
      stopReason: result.cancelled ? 'aborted' : 'end_turn',
      usage: { input_tokens: Number(result.input_tokens) || 0, output_tokens: Number(result.output_tokens) || 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      content: text ? [{ type: 'text', text }] : [],
      droppedComputer: Boolean((req.tools || []).length),
    };
    return out;
  }

  /** @param {import('./types').JsonRequest} req */
  async function json(req) {
    const r = await streamMessage({ apiKey: '', model: req.model, system: `${req.system || ''}\nAntworte nur mit JSON.`, messages: [{ role: 'user', content: req.prompt }], maxTokens: req.maxTokens || 600, format: req.schema, signal: req.signal });
    const raw = r.content.map((b) => /** @type {any} */ (b).text || '').join('');
    const m = raw.match(/\{[\s\S]*\}/);
    let data = null;
    try { data = m ? JSON.parse(m[0]) : null; } catch { data = null; }
    return { data, usage: r.usage, raw, stopReason: r.stopReason };
  }

  async function listModels() {
    return [];
  }

  return {
    provider: 'huggingface',
    listModels,
    streamMessage,
    json,
    stop,
    status: () => ({ state: stateValue, model: helper?.model || null, device, error: lastError }),
    // Modell schon laden (z. B. wenn das Island aufgeht), Fehler werden über den Status gemeldet
    preload: (/** @type {string} */ model) => ensure(String(model).replace(/^hf:/, '')).catch(() => {}),
  };
}

module.exports = { createHuggingFaceClient, toPlainMessages, HELPER_SCRIPT, hfModelId: (/** @type {string} */ p) => `${models.HF_PREFIX}${p}` };
