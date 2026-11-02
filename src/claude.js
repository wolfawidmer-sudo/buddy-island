// Kleine, abhängigkeitsfreie Anbindung an die Claude Messages API.
// Läuft im Main-Prozess, damit der API-Key nie im Fenster (Renderer) landet.

// BUDDY_API_BASE nur für Tests mit einem lokalen Mock-Server
const API_BASE = process.env.BUDDY_API_BASE || 'https://api.anthropic.com/v1';
const API_VERSION = '2023-06-01';

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
  return new ClaudeError(response.status, raw, type);
}

// Liest einen Server-Sent-Events-Stream und liefert { event, data } Objekte.
async function* parseSSE(body) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
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
    try {
      response = await fetchImpl(`${API_BASE}/models?limit=100`, { headers: headers(apiKey, workspaceId) });
    } catch {
      throw new ClaudeError(0, '');
    }
    if (!response.ok) throw await toError(response);
    const json = await response.json();
    return (json.data || []).map((m) => ({ id: m.id, name: m.display_name || m.id }));
  }

  async function post(apiKey, workspaceId, body, signal) {
    try {
      return await fetchImpl(`${API_BASE}/messages`, {
        method: 'POST',
        headers: headers(apiKey, workspaceId),
        body: JSON.stringify(body),
        signal,
      });
    } catch (err) {
      if (err?.name === 'AbortError') throw err;
      throw new ClaudeError(0, '');
    }
  }

  // Schickt eine Unterhaltung an Claude und ruft onText für jedes Textstück auf.
  // Gibt zusätzlich alle Content-Blöcke zurück (Text, Denk-Blöcke mit Signatur,
  // Tool-Aufrufe), damit sie in einer Tool-Schleife unverändert zurückgehen können.
  async function streamMessage({ apiKey, workspaceId, model, system, messages, tools, maxTokens, effort, signal, onText }) {
    const body = { model, max_tokens: maxTokens, messages, stream: true };
    if (system && system.trim()) body.system = system.trim();
    if (tools && tools.length) body.tools = tools;
    if (effort && effort !== 'auto') body.output_config = { effort };
    // Automatisches Prompt-Caching: spart viel Geld bei langen Steuerungs-Aufgaben
    body.cache_control = { type: 'ephemeral' };

    // Optionale Teile, die ältere Modelle evtl. nicht kennen: bei Fehler ohne sie neu versuchen.
    const optional = [
      { test: /output_config|effort/i, drop: () => { delete body.output_config; } },
      { test: /cache_control/i, drop: () => { delete body.cache_control; } },
      {
        test: /toolset|computer/i,
        drop: () => {
          body.tools = (body.tools || []).filter((t) => !String(t.type || '').startsWith('computer_'));
          if (!body.tools.length) delete body.tools;
          droppedComputer = true;
        },
      },
    ];
    let droppedComputer = false;

    let response = await post(apiKey, workspaceId, body, signal);
    for (let attempt = 0; attempt < optional.length && response.status === 400; attempt += 1) {
      const err = await toError(response);
      const fix = optional.find((o) => o.test.test(err.raw) && !o.used);
      if (!fix) throw err;
      fix.used = true;
      fix.drop();
      response = await post(apiKey, workspaceId, body, signal);
    }
    if (!response.ok) throw await toError(response);

    let stopReason = null;
    const usage = { input_tokens: 0, output_tokens: 0 };
    const blocks = [];
    const partialJson = new Map();

    for await (const { event, data } of parseSSE(response.body)) {
      if (event === 'message_start') {
        usage.input_tokens = data.message?.usage?.input_tokens || 0;
      } else if (event === 'content_block_start') {
        const block = JSON.parse(JSON.stringify(data.content_block || {}));
        if (block.type === 'tool_use') partialJson.set(data.index, '');
        blocks[data.index] = block;
      } else if (event === 'content_block_delta') {
        const block = blocks[data.index];
        const delta = data.delta || {};
        if (delta.type === 'text_delta') {
          if (block) block.text = (block.text || '') + delta.text;
          if (delta.text) onText(delta.text);
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
          }
        }
      } else if (event === 'message_delta') {
        stopReason = data.delta?.stop_reason || stopReason;
        if (data.usage?.output_tokens) usage.output_tokens = data.usage.output_tokens;
      } else if (event === 'error') {
        throw new ClaudeError(0, data.error?.message || 'Stream-Fehler', data.error?.type);
      }
    }
    return { stopReason, usage, content: blocks.filter(Boolean), droppedComputer };
  }

  return { listModels, streamMessage };
}

module.exports = { createClient, parseSSE, ClaudeError, FALLBACK_MODELS, friendlyMessage };
