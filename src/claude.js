// Kleine, abhängigkeitsfreie Anbindung an die Claude Messages API.
// Läuft im Main-Prozess, damit der API-Key nie im Fenster (Renderer) landet.

// Der API-Key geht nur an api.anthropic.com. BUDDY_API_BASE ist nur für Tests
// mit einem lokalen Mock-Server und wird für alle anderen Adressen ignoriert.
const DEFAULT_BASE = 'https://api.anthropic.com/v1';
function apiBase() {
  const override = process.env.BUDDY_API_BASE;
  if (override && /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?\//i.test(override)) return override.replace(/\/$/, '');
  return DEFAULT_BASE;
}
const API_BASE = apiBase();
const API_VERSION = '2023-06-01';

// Zuverlässigkeit: Wiederholungen bei vorübergehenden Fehlern, Zeitlimits
const RETRY_STATUS = new Set([408, 429, 500, 502, 503, 504, 529]);
const RETRY_DELAYS = [1500, 4000, 10000];
const CONNECT_TIMEOUT_MS = 45000; // bis die Antwort beginnt
const IDLE_TIMEOUT_MS = 90000; // längste Pause im Stream

// Fallback, falls die Modell-Liste nicht geladen werden kann.
const FALLBACK_MODELS = [
  { id: 'claude-sonnet-5-5', name: 'Claude Sonnet 5.5' },
  { id: 'claude-haiku-5-5', name: 'Claude Haiku 5.5' },
  { id: 'claude-opus-5-5', name: 'Claude Opus 5.5' },
];

class ClaudeError extends Error {
  constructor(status, raw, type) {
    super(friendlyMessage(status, raw, type));
    this.status = status;
    this.raw = raw || '';
    this.type = type || '';
  }
}

function friendlyMessage(status, raw = '', type = '') {
  const text = `${raw} ${type}`.toLowerCase();
  if (text.includes('workspace')) return 'Dein Key braucht eine Workspace-ID. Trag sie in den Einstellungen ein oder erstelle einen Key für einen bestimmten Workspace.';
  if (text.includes('credit balance')) return 'Dein API-Guthaben ist aufgebraucht. Lade es in der Claude Console auf.';
  if (status === 401 || type === 'authentication_error') return 'Der API-Key ist ungültig. Prüfe ihn in den Einstellungen.';
  if (status === 403 || type === 'permission_error') return 'Dieser Key hat keinen Zugriff darauf (z. B. auf dieses Modell).';
  if (status === 404 || type === 'not_found_error') return 'Das Modell wurde nicht gefunden. Wähle in den Einstellungen ein anderes.';
  if (status === 413) return 'Die Unterhaltung ist zu lang. Starte einen neuen Chat.';
  if (status === 429 || type === 'rate_limit_error') return 'Zu viele Anfragen. Warte kurz und versuch es nochmals.';
  if (status === 529 || type === 'overloaded_error') return 'Claude ist gerade überlastet. Versuch es gleich nochmals.';
  if (status >= 500) return 'Bei Claude ist ein Fehler aufgetreten. Versuch es nochmals.';
  if (type === 'timeout_error') return 'Claude antwortet gerade nicht (Zeitüberschreitung). Versuch es gleich nochmals.';
  if (status === 0 && !raw) return 'Keine Verbindung zu Claude. Bist du online?';
  return raw || `Unbekannter Fehler (${status})`;
}

function headers(apiKey, workspaceId) {
  const h = {
    authorization: `Bearer ${apiKey}`,
    'anthropic-version': API_VERSION,
    'content-type': 'application/json',
  };
  if (workspaceId && workspaceId.trim()) h['anthropic-workspace-id'] = workspaceId.trim();
  return h;
}

async function toError(response) {
  let raw = '';
  let type = '';
  try {
    const json = await response.json();
    raw = json?.error?.message || '';
    type = json?.error?.type || '';
  } catch {
    /* Antwort war kein JSON */
  }
  const err = new ClaudeError(response.status, raw, type);
  const after = Number(response.headers?.get?.('retry-after'));
  if (Number.isFinite(after) && after > 0) err.retryAfterMs = Math.min(20000, after * 1000);
  return err;
}

const isRetryable = (err) => err instanceof ClaudeError && (err.status === 0 || RETRY_STATUS.has(err.status) || err.type === 'overloaded_error' || err.type === 'api_error');

function abortError() {
  return Object.assign(new Error('abgebrochen'), { name: 'AbortError' });
}

function wait(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(abortError()); return; }
    const t = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => { clearTimeout(t); reject(abortError()); }, { once: true });
  });
}

// Liest einen Server-Sent-Events-Stream und liefert { event, data } Objekte.
async function* parseSSE(body, onChunk) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      onChunk?.();
      buffer += decoder.decode(value, { stream: true });
      // Ein \r am Ende könnte zu einem \r\n gehören, das im nächsten Stück weitergeht.
      let tail = '';
      if (buffer.endsWith('\r')) {
        tail = '\r';
        buffer = buffer.slice(0, -1);
      }
      buffer = buffer.replace(/\r\n|\r/g, '\n');
      let boundary;
      while ((boundary = buffer.indexOf('\n\n')) !== -1) {
        const chunk = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        const parsed = parseEvent(chunk);
        if (parsed) yield parsed;
      }
      buffer += tail;
    }
    const rest = parseEvent(buffer.replace(/\r\n|\r/g, '\n'));
    if (rest) yield rest;
  } finally {
    reader.releaseLock();
  }
}

function parseEvent(chunk) {
  let event = 'message';
  const dataLines = [];
  for (const line of chunk.split('\n')) {
    if (line.startsWith('event:')) event = line.slice(6).trim();
    else if (line.startsWith('data:')) dataLines.push(line.slice(5).trimStart());
  }
  if (!dataLines.length) return null;
  try {
    return { event, data: JSON.parse(dataLines.join('\n')) };
  } catch {
    return null;
  }
}

function createClient(fetchImpl = globalThis.fetch) {
  async function listModels(apiKey, workspaceId) {
    let response;
    const local = new AbortController();
    const timer = setTimeout(() => local.abort(), 20000);
    try {
      response = await fetchImpl(`${API_BASE}/models?limit=100`, { headers: headers(apiKey, workspaceId), signal: local.signal });
    } catch {
      throw new ClaudeError(0, '', local.signal.aborted ? 'timeout_error' : '');
    } finally {
      clearTimeout(timer);
    }
    if (!response.ok) throw await toError(response);
    const json = await response.json();
    return (json.data || []).map((m) => ({ id: m.id, name: m.display_name || m.id }));
  }

  // Ein Versuch mit Zeitlimit bis zur ersten Antwort. Gibt zusätzlich einen
  // Controller zurück, mit dem der Stream bei langer Pause abgebrochen wird.
  async function postOnce(apiKey, workspaceId, body, signal) {
    const local = new AbortController();
    const onAbort = () => local.abort();
    if (signal?.aborted) throw abortError();
    signal?.addEventListener('abort', onAbort, { once: true });
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; local.abort(); }, CONNECT_TIMEOUT_MS);
    try {
      const response = await fetchImpl(`${API_BASE}/messages`, {
        method: 'POST',
        headers: headers(apiKey, workspaceId),
        body: JSON.stringify(body),
        signal: local.signal,
      });
      return { response, local, timedOut: () => timedOut, cleanup: () => signal?.removeEventListener('abort', onAbort) };
    } catch (err) {
      signal?.removeEventListener('abort', onAbort);
      if (timedOut) throw new ClaudeError(0, '', 'timeout_error');
      if (signal?.aborted || err?.name === 'AbortError') throw abortError();
      throw new ClaudeError(0, '');
    } finally {
      clearTimeout(timer);
    }
  }

  // Mit kontrollierten Wiederholungen bei Netzwerkfehlern, 429, 5xx und Überlastung
  async function post(apiKey, workspaceId, body, signal, onRetry) {
    for (let attempt = 0; ; attempt += 1) {
      let result;
      try {
        result = await postOnce(apiKey, workspaceId, body, signal);
      } catch (err) {
        if (err?.name === 'AbortError' || !isRetryable(err) || attempt >= RETRY_DELAYS.length) throw err;
        onRetry?.(attempt + 1, err);
        await wait(RETRY_DELAYS[attempt], signal);
        continue;
      }
      const { response } = result;
      if (response.ok || response.status === 400 || !RETRY_STATUS.has(response.status) || attempt >= RETRY_DELAYS.length) return result;
      const err = await toError(response);
      result.cleanup();
      if (!isRetryable(err)) return { ...result, response: { ok: false, status: err.status, json: async () => ({ error: { message: err.raw, type: err.type } }), headers: response.headers } };
      onRetry?.(attempt + 1, err);
      await wait(err.retryAfterMs || RETRY_DELAYS[attempt], signal);
    }
  }

  // Schickt eine Unterhaltung an Claude und ruft onText für jedes Textstück auf.
  // Gibt zusätzlich alle Content-Blöcke zurück (Text, Denk-Blöcke mit Signatur,
  // Tool-Aufrufe), damit sie in einer Tool-Schleife unverändert zurückgehen können.
  // format: JSON-Schema für strukturierte Antworten (z. B. für den Router).
  async function streamMessage({ apiKey, workspaceId, model, system, messages, tools, maxTokens, effort, format, signal, onText, onRetry }) {
    const body = { model, max_tokens: maxTokens, messages, stream: true };
    if (system && system.trim()) body.system = system.trim();
    if (tools && tools.length) body.tools = tools;
    const outputConfig = {};
    if (effort && effort !== 'auto') outputConfig.effort = effort;
    if (format) outputConfig.format = { type: 'json_schema', schema: format };
    if (Object.keys(outputConfig).length) body.output_config = outputConfig;
    // Automatisches Prompt-Caching: spart viel Geld bei langen Steuerungs-Aufgaben
    body.cache_control = { type: 'ephemeral' };

    let droppedComputer = false;
    let droppedFormat = false;
    // Optionale Teile, die ältere Modelle evtl. nicht kennen: bei Fehler ohne sie neu versuchen.
    const optional = [
      {
        test: /format|json_schema/i,
        drop: () => {
          if (!body.output_config?.format) return false;
          delete body.output_config.format;
          if (!Object.keys(body.output_config).length) delete body.output_config;
          droppedFormat = true;
          return true;
        },
      },
      { test: /output_config|effort/i, drop: () => (body.output_config ? (delete body.output_config, true) : false) },
      { test: /cache_control/i, drop: () => (body.cache_control ? (delete body.cache_control, true) : false) },
      {
        test: /toolset|computer/i,
        drop: () => {
          const before = (body.tools || []).length;
          body.tools = (body.tools || []).filter((t) => !String(t.type || '').startsWith('computer_'));
          if (!body.tools.length) delete body.tools;
          droppedComputer = true;
          return before !== (body.tools || []).length;
        },
      },
    ];

    let attempt = await post(apiKey, workspaceId, body, signal, onRetry);
    for (let i = 0; i < optional.length && attempt.response.status === 400; i += 1) {
      const err = await toError(attempt.response);
      attempt.cleanup();
      const fix = optional.find((o) => !o.used && o.test.test(err.raw));
      if (!fix) throw err;
      fix.used = true;
      if (!fix.drop()) throw err;
      attempt = await post(apiKey, workspaceId, body, signal, onRetry);
    }
    if (!attempt.response.ok) {
      attempt.cleanup();
      throw await toError(attempt.response);
    }

    const { response, local } = attempt;
    let stopReason = null;
    const usage = { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 };
    const takeUsage = (u) => {
      if (!u) return;
      for (const k of Object.keys(usage)) if (typeof u[k] === 'number') usage[k] = u[k];
    };
    const blocks = [];
    const partialJson = new Map();

    // Bei langer Funkstille abbrechen statt ewig zu warten
    let idle = null;
    let idleHit = false;
    const kick = () => {
      clearTimeout(idle);
      idle = setTimeout(() => { idleHit = true; local.abort(); }, IDLE_TIMEOUT_MS);
    };
    kick();

    try {
      for await (const { event, data } of parseSSE(response.body, kick)) {
        if (event === 'message_start') {
          takeUsage(data.message?.usage);
        } else if (event === 'content_block_start') {
          const block = JSON.parse(JSON.stringify(data.content_block || {}));
          if (block.type === 'tool_use') partialJson.set(data.index, '');
          blocks[data.index] = block;
        } else if (event === 'content_block_delta') {
          const block = blocks[data.index];
          const delta = data.delta || {};
          if (delta.type === 'text_delta') {
            if (block) block.text = (block.text || '') + delta.text;
            if (delta.text) onText?.(delta.text);
          } else if (delta.type === 'thinking_delta' && block) {
            block.thinking = (block.thinking || '') + delta.thinking;
          } else if (delta.type === 'signature_delta' && block) {
            block.signature = (block.signature || '') + delta.signature;
          } else if (delta.type === 'input_json_delta') {
            partialJson.set(data.index, (partialJson.get(data.index) || '') + (delta.partial_json || ''));
          }
        } else if (event === 'content_block_stop') {
          const block = blocks[data.index];
          if (block && block.type === 'tool_use') {
            const raw = partialJson.get(data.index) || '';
            try {
              block.input = raw ? JSON.parse(raw) : block.input || {};
            } catch {
              block.input = {};
              block.invalidJson = true;
            }
          }
        } else if (event === 'message_delta') {
          stopReason = data.delta?.stop_reason || stopReason;
          takeUsage(data.usage);
        } else if (event === 'error') {
          throw new ClaudeError(0, data.error?.message || 'Stream-Fehler', data.error?.type);
        }
      }
    } catch (err) {
      if (idleHit) throw new ClaudeError(0, '', 'timeout_error');
      if (signal?.aborted || err?.name === 'AbortError') throw abortError();
      if (err instanceof ClaudeError) throw err;
      throw new ClaudeError(0, '');
    } finally {
      clearTimeout(idle);
      attempt.cleanup();
    }
    // Interne Markierung nicht an die API zurückschicken
    const content = blocks.filter(Boolean).map((b) => {
      if (b.type !== 'tool_use' || !b.invalidJson) return b;
      const { invalidJson, ...rest } = b;
      Object.defineProperty(rest, 'invalidJson', { value: true, enumerable: false });
      return rest;
    });
    return { stopReason, usage, content, droppedComputer, droppedFormat };
  }

  // Kurze strukturierte Anfrage (z. B. Router). Liefert { data, usage, raw }.
  async function json({ apiKey, workspaceId, model, system, prompt, schema, maxTokens = 700, effort = 'low', signal }) {
    const result = await streamMessage({
      apiKey, workspaceId, model, system, maxTokens, effort, signal,
      messages: [{ role: 'user', content: prompt }],
      format: schema,
    });
    const text = result.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
    let data = null;
    try {
      data = JSON.parse(text);
    } catch {
      const m = text.match(/\{[\s\S]*\}/);
      if (m) { try { data = JSON.parse(m[0]); } catch { data = null; } }
    }
    return { data, usage: result.usage, raw: text, stopReason: result.stopReason };
  }

  return { listModels, streamMessage, json };
}

module.exports = { createClient, parseSSE, ClaudeError, FALLBACK_MODELS, friendlyMessage, isRetryable, API_BASE };
