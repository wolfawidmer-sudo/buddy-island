// @ts-check
// Chat-Adapter für lokale Modelle (Anbieter «local», Laufzeit über src/local/).
// Übersetzt Buddys Content-Block-Format (wie Claude) in das Chat-Format von Ollama und zurück:
// Streaming, Werkzeugaufrufe (nur wenn das Modell sie laut Ollama kann), Bilder (nur bei
// Bildmodellen), strukturierte Antworten über JSON-Schema.
//
// Kontext: Die Kontextlänge kommt aus dem Speicherplan. Wird das Gespräch zu lang, fasst das
// Modell den älteren Teil einmal kurz zusammen und Buddy sagt das im Chat (nichts geht still
// verloren). Alles bleibt auf diesem PC: Anfragen gehen nur an 127.0.0.1.

const crypto = require('crypto');
const { ProviderError, abortError } = require('./errors');
const { t } = require('../i18n');

/** @typedef {import('./types').LlmClient} LlmClient */
/** @typedef {import('./types').Message} Message */
/** @typedef {import('./types').StreamRequest} StreamRequest */
/** @typedef {import('./types').StreamResult} StreamResult */

const PREFIX = 'local:';
const NAME = 'Lokal';

/** Grobe Token-Schätzung (gemischte Sprachen, Code): ~3.5 Zeichen pro Token @param {string} s */
const approxTokens = (s) => Math.ceil(String(s || '').length / 3.5);

/** Verständliche Meldung zu einem Laufzeit-Fehler @param {any} err @param {string} model */
function friendly(err, model) {
  const name = model || t('das Modell');
  switch (err?.code) {
    case 'runtime_missing': return t('Die lokale KI ist noch nicht eingerichtet. Öffne die Einstellungen, um sie einzurichten.');
    case 'unreachable':
    case 'runtime_failed':
    case 'port_in_use': return t('Ollama läuft gerade nicht und liess sich nicht starten. Details findest du in den Einstellungen unter «Lokale KI» → «Diagnose».');
    case 'not_found':
    case 'no_model': return t('Das Modell «{model}» ist nicht auf diesem PC. Lade es in den Einstellungen herunter oder wähle ein anderes.', { model: name });
    case 'out_of_memory': return t('Für «{model}» reicht der Speicher gerade nicht. Schliesse grosse Programme oder wähle ein kleineres Modell.', { model: name });
    case 'low_ram': return t('Gerade ist zu wenig Arbeitsspeicher frei, um «{model}» zu laden. Schliesse ein paar Programme oder wähle ein kleineres Modell.', { model: name });
    case 'gpu_error': return t('Die Grafikkarte hat beim Rechnen einen Fehler gemeldet. Oft hilft ein aktueller Grafiktreiber. Du kannst in den erweiterten Einstellungen auch «Nur Prozessor» wählen.');
    case 'runner_crashed': return t('Das lokale Modell ist abgestürzt. Schick die Nachricht nochmals, Buddy startet es neu.');
    case 'timeout': return t('Das lokale Modell antwortet nicht mehr. Versuch es nochmals oder wähle ein kleineres Modell.');
    case 'unsupported': return t('«{model}» kann das nicht (z. B. Werkzeuge oder Bilder).', { model: name });
    case 'runtime_too_old': return t('Dieses Modell braucht eine neuere Version von Ollama. Aktualisiere Ollama und versuch es nochmals.');
    case 'disk_full': return t('Auf dem Laufwerk ist nicht genug Platz frei.');
    default: return t('Das lokale Modell meldet einen Fehler: {e}', { e: String(err?.message || err || '').slice(0, 160) });
  }
}

/** @param {any} err @param {string} model */
function toProviderError(err, model) {
  if (err?.name === 'AbortError') return err;
  if (err instanceof ProviderError) return err;
  const e = new ProviderError(0, friendly(err, model), 'local_error', NAME, { providerId: 'local', model: `${PREFIX}${model}`, endpoint: 'http://127.0.0.1:11434/api/chat', stage: 'local', code: err?.code || 'error' });
  e.raw = String(err?.raw || err?.message || '');
  // @ts-ignore für die Oberfläche: Code der Laufzeit
  e.localCode = err?.code || 'error';
  return e;
}

/**
 * Buddys Nachrichten → Ollama-Nachrichten.
 * @param {Message[]} messages @param {string|undefined} system @param {{ vision: boolean }} caps
 */
function toOllamaMessages(messages, system, caps) {
  /** @type {any[]} */
  const out = [];
  if (system && system.trim()) out.push({ role: 'system', content: system.trim() });
  /** @type {Map<string, string>} Werkzeug-ID → Name (Ollama will den Namen beim Ergebnis) */
  const names = new Map();
  for (const m of messages) {
    if (typeof m.content === 'string') {
      if (m.content) out.push({ role: m.role, content: m.content });
      continue;
    }
    if (m.role === 'assistant') {
      const text = m.content.filter((b) => b.type === 'text').map((b) => /** @type {any} */ (b).text).join('');
      const calls = m.content.filter((b) => b.type === 'tool_use').map((b) => {
        const u = /** @type {import('./types').ToolUseBlock} */ (b);
        names.set(u.id, u.name);
        return { function: { name: u.name, arguments: u.input || {} } };
      });
      /** @type {any} */
      const msg = { role: 'assistant', content: text };
      if (calls.length) msg.tool_calls = calls;
      if (text || calls.length) out.push(msg);
      continue;
    }
    /** @type {string[]} */
    const texts = [];
    /** @type {string[]} */
    const images = [];
    let dropped = 0;
    for (const b of m.content) {
      if (b.type === 'tool_result') {
        const r = /** @type {import('./types').ToolResultBlock} */ (b);
        const blocks = typeof r.content === 'string' ? [{ type: 'text', text: r.content }] : r.content || [];
        const text = blocks.filter((x) => x.type === 'text').map((x) => /** @type {any} */ (x).text).join('\n');
        out.push({ role: 'tool', tool_name: names.get(r.tool_use_id) || '', content: `${r.is_error ? 'ERROR: ' : ''}${text || 'OK'}` });
        for (const x of blocks) if (x.type === 'image') { if (caps.vision) images.push(/** @type {any} */ (x).source.data); else dropped += 1; }
      } else if (b.type === 'text') {
        texts.push(/** @type {any} */ (b).text);
      } else if (b.type === 'image') {
        if (caps.vision) images.push(/** @type {any} */ (b).source.data);
        else dropped += 1;
      }
    }
    if (dropped) texts.push(t('[Bild weggelassen: dieses Modell kann keine Bilder sehen]'));
    if (texts.length || images.length) {
      /** @type {any} */
      const msg = { role: 'user', content: texts.join('\n\n') };
      if (images.length) msg.images = images;
      // Gleiche Rollen nacheinander zusammenfassen
      const prev = out[out.length - 1];
      if (prev && prev.role === 'user' && !prev.images && !images.length) prev.content += `\n\n${msg.content}`;
      else out.push(msg);
    }
  }
  return out;
}

/** @param {import('./types').Tool[]|undefined} tools */
function toOllamaTools(tools) {
  const out = [];
  let dropped = false;
  for (const tool of tools || []) {
    if ('name' in tool && tool.name) out.push({ type: 'function', function: { name: tool.name, description: tool.description || '', parameters: tool.input_schema || { type: 'object', properties: {} } } });
    else dropped = true;
  }
  return { tools: out, dropped };
}

/** Tokens einer Ollama-Nachricht (Bilder grob mit 600) @param {any} m */
const msgTokens = (m) => approxTokens(m.content) + (m.tool_calls ? approxTokens(JSON.stringify(m.tool_calls)) : 0) + (m.images ? m.images.length * 600 : 0) + 4;

/**
 * Kürzt den Verlauf auf das Budget. Schnitte nur vor einer echten Nutzer-Nachricht, damit
 * Werkzeugaufrufe und ihre Ergebnisse zusammenbleiben. Gibt den behaltenen Teil und den
 * weggelassenen (zum Zusammenfassen) zurück.
 * @param {any[]} msgs @param {number} budget
 */
function fitToBudget(msgs, budget) {
  const sys = msgs[0]?.role === 'system' ? [msgs[0]] : [];
  const rest = msgs.slice(sys.length);
  const total = msgs.reduce((s, m) => s + msgTokens(m), 0);
  if (total <= budget) return { kept: msgs, dropped: [] };
  // Mögliche Schnittstellen: Nutzer-Nachrichten (nicht Werkzeug-Ergebnisse)
  const cuts = rest.map((m, i) => (m.role === 'user' ? i : -1)).filter((i) => i > 0);
  const sysTokens = sys.reduce((s, m) => s + msgTokens(m), 0);
  for (const cut of cuts) {
    const kept = rest.slice(cut);
    const size = sysTokens + kept.reduce((s, m) => s + msgTokens(m), 0) + 400; // Platz für die Zusammenfassung
    if (size <= budget) return { kept: [...sys, ...kept], dropped: rest.slice(0, cut) };
  }
  // Selbst die letzte Nutzer-Nachricht ist zu lang: nur sie behalten (gekürzt)
  const last = rest[rest.length - 1];
  const room = Math.max(256, budget - sysTokens - 200) * 3.5;
  const trimmed = last && typeof last.content === 'string' && last.content.length > room ? { ...last, content: `${last.content.slice(0, Math.floor(room / 2))}\n…\n${last.content.slice(-Math.floor(room / 2))}` } : last;
  return { kept: [...sys, trimmed].filter(Boolean), dropped: rest.slice(0, -1), truncated: trimmed !== last };
}

/**
 * @param {{
 *   manager: ReturnType<import('../local/manager')['createLocalManager']>,
 *   getAdvanced?: () => { temperature: number|null, topP: number|null, maxTokens: number|null },
 *   allowTools?: () => boolean,
 *   log?: (m: string) => void,
 * }} deps
 * @returns {LlmClient & { summaries: Map<string, string> }}
 */
function createLocalClient({ manager, getAdvanced = () => ({ temperature: null, topP: null, maxTokens: null }), allowTools = () => true, log = () => {} }) {
  const runtime = manager.runtime;
  /** @type {Map<string, string>} Hash des weggelassenen Teils → Zusammenfassung */
  const summaries = new Map();

  /** @param {string} model */
  async function prepare(model) {
    await manager.ensureLoaded(model);
    const { options } = await manager.optionsFor(model);
    const caps = manager.capsOf(model);
    // Denken aus: schneller und kein Selbstgespräch im Chat. Modelle, die immer denken, auf «wenig».
    const think = caps.thinking ? (caps.alwaysThinks ? (/gpt-oss/.test(model) ? 'low' : null) : false) : null;
    return { options, caps, think, keepAlive: manager.keepAliveValue() };
  }

  /**
   * Fasst den weggelassenen Teil einmal zusammen (zwischengespeichert)
   * @param {string} model @param {any[]} dropped @param {any} base
   */
  async function summarize(model, dropped, base, signal) {
    const text = dropped.map((m) => `${m.role === 'assistant' ? 'Buddy' : m.role === 'tool' ? 'Tool' : 'User'}: ${String(m.content || '').slice(0, 2000)}`).join('\n');
    const key = crypto.createHash('sha256').update(`${model}\n${text}`).digest('hex');
    const cached = summaries.get(key);
    if (cached) return cached;
    const r = await runtime.chat({
      model,
      messages: [
        { role: 'system', content: 'Summarize the conversation below in at most 120 words, in the language of the conversation. Keep names, numbers, decisions and open questions. No preamble.' },
        { role: 'user', content: text.slice(-24000) },
      ],
      options: { ...base.options, num_predict: 300, temperature: 0.2 },
      think: base.think,
      keepAlive: base.keepAlive,
      signal,
    });
    const s = r.content.trim();
    if (s) {
      summaries.set(key, s);
      if (summaries.size > 50) { const first = summaries.keys().next().value; if (first) summaries.delete(first); }
    }
    return s;
  }

  /** @param {StreamRequest & { onNotice?: (text: string) => void }} req @returns {Promise<StreamResult>} */
  async function streamMessage(req) {
    const model = String(req.model || '').replace(/^local:/, '');
    if (!model) throw toProviderError({ code: 'no_model' }, '');
    if (req.signal?.aborted) throw abortError();
    try {
      const base = await prepare(model);
      const adv = getAdvanced();
      const toolInfo = base.caps.tools && allowTools() ? toOllamaTools(req.tools) : { tools: [], dropped: Boolean((req.tools || []).length) };
      let msgs = toOllamaMessages(req.messages, req.system, base.caps);
      const ctx = base.options.num_ctx || 4096;
      const maxOut = Math.min(req.maxTokens || 1024, adv.maxTokens || 4096, Math.floor(ctx / 3));
      const toolTokens = toolInfo.tools.length ? approxTokens(JSON.stringify(toolInfo.tools)) : 0;
      const budget = ctx - maxOut - toolTokens - 128;
      const fitted = fitToBudget(msgs, budget);
      if (fitted.dropped.length) {
        let summary = '';
        try {
          summary = await summarize(model, fitted.dropped, base, req.signal);
        } catch (err) {
          if (req.signal?.aborted) throw abortError();
          log(`Lokale KI: Zusammenfassung fehlgeschlagen (${/** @type {Error} */ (err).message})`);
        }
        msgs = fitted.kept;
        const note = summary
          ? `Earlier part of this conversation (summarized, details may be missing):\n${summary}`
          : 'Earlier messages of this conversation were removed because they no longer fit.';
        if (msgs[0]?.role === 'system') msgs[0] = { ...msgs[0], content: `${msgs[0].content}\n\n${note}` };
        else msgs.unshift({ role: 'system', content: note });
        req.onNotice?.(summary
          ? t('Das Gespräch ist lang geworden: Ältere Nachrichten sind nur noch als Zusammenfassung dabei. Für ein neues Thema am besten einen neuen Chat starten.')
          : t('Das Gespräch ist zu lang für dieses Modell: Ältere Nachrichten sind nicht mehr dabei. Starte für ein neues Thema einen neuen Chat.'));
      }
      /** @type {Record<string, number>} */
      const options = { ...base.options, num_predict: maxOut };
      options.temperature = req.format ? 0 : adv.temperature ?? 0.7;
      if (adv.topP !== null && adv.topP !== undefined) options.top_p = adv.topP;
      const r = await runtime.chat({
        model, messages: msgs, tools: toolInfo.tools, options, think: base.think, keepAlive: base.keepAlive,
        format: req.format, signal: req.signal, onDelta: (x) => req.onText?.(x),
      });
      manager.recordPerf(model, r.timings);
      /** @type {import('./types').ContentBlock[]} */
      const content = [];
      if (r.content) content.push({ type: 'text', text: r.content });
      for (const c of r.toolCalls) {
        let input = c.function?.arguments;
        if (typeof input === 'string') { try { input = JSON.parse(input); } catch { input = {}; } }
        content.push({ type: 'tool_use', id: `call_${crypto.randomBytes(6).toString('hex')}`, name: String(c.function?.name || ''), input: input && typeof input === 'object' ? input : {} });
      }
      const hasTools = content.some((b) => b.type === 'tool_use');
      return {
        stopReason: hasTools ? 'tool_use' : r.doneReason === 'length' ? 'max_tokens' : 'end_turn',
        usage: { input_tokens: r.promptTokens, output_tokens: r.evalTokens, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
        content,
        droppedComputer: toolInfo.dropped,
      };
    } catch (err) {
      if (/** @type {any} */ (err)?.name === 'AbortError' || req.signal?.aborted) throw abortError();
      await manager.noteChatError(err).catch(() => {});
      throw toProviderError(err, model);
    }
  }

  /** @param {import('./types').JsonRequest} req */
  async function json(req) {
    const r = await streamMessage({ apiKey: '', model: req.model, system: req.system, messages: [{ role: 'user', content: req.prompt }], maxTokens: req.maxTokens || 600, format: req.schema, signal: req.signal });
    const raw = r.content.map((b) => /** @type {any} */ (b).text || '').join('');
    let data = null;
    try { data = JSON.parse(raw); } catch {
      const m = raw.match(/\{[\s\S]*\}/);
      try { data = m ? JSON.parse(m[0]) : null; } catch { data = null; }
    }
    return { data, usage: r.usage, raw, stopReason: r.stopReason };
  }

  async function listModels() {
    const list = await runtime.list().catch(() => []);
    return list.map((m) => ({ id: `${PREFIX}${m.id}`, name: m.id }));
  }

  return { provider: 'local', listModels, streamMessage, json, summaries };
}

module.exports = { createLocalClient, toOllamaMessages, toOllamaTools, fitToBudget, friendly, approxTokens, PREFIX };
