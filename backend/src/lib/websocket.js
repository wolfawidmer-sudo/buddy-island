'use strict';
// Kleiner WebSocket-Server (RFC 6455) ohne Abhängigkeiten: nur das, was das Buddy-Live-Relay braucht.
// Text- und Binär-Nachrichten, Fragmente, Ping/Pong, Close. Erwartet maskierte Frames vom Client.
// Grenzen: maxPayload pro Nachricht (Frames und zusammengesetzte Fragmente), sonst Close 1009.
// Clients (App, Tests) nutzen den eingebauten WebSocket von Node/Electron (undici).

const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const UTF8 = new TextDecoder('utf-8', { fatal: true });
const TOKEN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

/** Angebotene Subprotokolle aus dem Header (kommagetrennt, nur gültige Tokens) */
function offeredProtocols(req) {
  return String(req.headers['sec-websocket-protocol'] || '')
    .split(',').map((s) => s.trim()).filter((s) => s && s.length <= 512 && TOKEN.test(s));
}

/** Upgrade ablehnen: einfache HTTP-Antwort, dann Socket schliessen */
function rejectUpgrade(socket, status, message = '') {
  const text = { 400: 'Bad Request', 401: 'Unauthorized', 402: 'Payment Required', 403: 'Forbidden', 404: 'Not Found', 409: 'Conflict', 426: 'Upgrade Required', 429: 'Too Many Requests', 503: 'Service Unavailable' }[status] || 'Error';
  const body = JSON.stringify({ error: { code: message || text.toLowerCase().replace(/ /g, '_') } });
  try {
    socket.end(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Type: application/json\r\nCache-Control: no-store\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
  } catch { /* schon zu */ }
  setTimeout(() => socket.destroy(), 1000).unref?.();
}

/**
 * Handshake prüfen und annehmen. Gibt eine Verbindung zurück oder null (dann schon abgelehnt).
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:stream').Duplex} socket
 * @param {Buffer} head
 * @param {{ protocol?: string|null, maxPayload?: number }} opts
 */
function acceptUpgrade(req, socket, head, { protocol = null, maxPayload = 256 * 1024 } = {}) {
  const key = String(req.headers['sec-websocket-key'] || '');
  const upgrade = String(req.headers.upgrade || '').toLowerCase();
  if (req.method !== 'GET' || upgrade !== 'websocket' || String(req.headers['sec-websocket-version']) !== '13' || !/^[A-Za-z0-9+/]{22}==$/.test(key)) {
    rejectUpgrade(socket, 400);
    return null;
  }
  const accept = crypto.createHash('sha1').update(key + GUID).digest('base64');
  const lines = ['HTTP/1.1 101 Switching Protocols', 'Upgrade: websocket', 'Connection: Upgrade', `Sec-WebSocket-Accept: ${accept}`];
  if (protocol) lines.push(`Sec-WebSocket-Protocol: ${protocol}`);
  socket.write(`${lines.join('\r\n')}\r\n\r\n`);
  const conn = new Connection(socket, { maxPayload });
  if (head && head.length) conn._feed(head);
  return conn;
}

class Connection extends EventEmitter {
  /** @param {import('node:stream').Duplex} socket @param {{ maxPayload: number }} opts */
  constructor(socket, { maxPayload }) {
    super();
    this.socket = socket;
    this.maxPayload = maxPayload;
    this.buf = Buffer.alloc(0);
    /** @type {{ opcode: number, parts: Buffer[], size: number } | null} */
    this.frag = null;
    this.closed = false;
    this.closeSent = false;
    this.bufferedAmount = () => socket.writableLength || 0;
    if (typeof socket.setNoDelay === 'function') socket.setNoDelay(true);
    socket.on('data', (d) => this._feed(d));
    socket.on('error', () => this._gone(1006, ''));
    socket.on('close', () => this._gone(1006, ''));
  }

  _feed(chunk) {
    if (this.closed) return;
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    try {
      while (this._frame()) { /* weiter */ }
    } catch (err) {
      this.close(err.code === 1009 ? 1009 : 1002, err.code === 1009 ? 'message too big' : 'protocol error');
    }
  }

  /** Einen Frame lesen, wenn vollständig. @returns {boolean} weiterlesen? */
  _frame() {
    const b = this.buf;
    if (b.length < 2) return false;
    const fin = (b[0] & 0x80) !== 0;
    if (b[0] & 0x70) throw Object.assign(new Error('rsv'), { code: 1002 });
    const opcode = b[0] & 0x0f;
    const masked = (b[1] & 0x80) !== 0;
    let len = b[1] & 0x7f;
    let off = 2;
    if (len === 126) {
      if (b.length < 4) return false;
      len = b.readUInt16BE(2);
      off = 4;
    } else if (len === 127) {
      if (b.length < 10) return false;
      const hi = b.readUInt32BE(2);
      if (hi !== 0) throw Object.assign(new Error('too big'), { code: 1009 });
      len = b.readUInt32BE(6);
      off = 10;
    }
    if (!masked) throw Object.assign(new Error('unmasked'), { code: 1002 });
    if (len > this.maxPayload) throw Object.assign(new Error('too big'), { code: 1009 });
    if (b.length < off + 4 + len) return false;
    const mask = b.subarray(off, off + 4);
    const payload = Buffer.from(b.subarray(off + 4, off + 4 + len));
    for (let i = 0; i < payload.length; i += 1) payload[i] ^= mask[i & 3];
    this.buf = b.subarray(off + 4 + len);

    if (opcode >= 0x8) {
      if (!fin || len > 125) throw Object.assign(new Error('control'), { code: 1002 });
      if (opcode === 0x8) {
        const code = payload.length >= 2 ? payload.readUInt16BE(0) : 1005;
        const reason = payload.length > 2 ? payload.subarray(2).toString('utf8') : '';
        if (!this.closeSent) this._send(0x8, payload.length >= 2 ? payload.subarray(0, 2) : Buffer.alloc(0));
        this._gone(code, reason);
        try { this.socket.end(); } catch { /* egal */ }
        return false;
      }
      if (opcode === 0x9) this._send(0xa, payload);
      return true;
    }
    if (opcode === 0x0) {
      if (!this.frag) throw Object.assign(new Error('continuation'), { code: 1002 });
      this.frag.parts.push(payload);
      this.frag.size += payload.length;
      if (this.frag.size > this.maxPayload) throw Object.assign(new Error('too big'), { code: 1009 });
      if (fin) {
        const { opcode: op, parts } = this.frag;
        this.frag = null;
        this._message(op, Buffer.concat(parts));
      }
      return true;
    }
    if (opcode !== 0x1 && opcode !== 0x2) throw Object.assign(new Error('opcode'), { code: 1002 });
    if (this.frag) throw Object.assign(new Error('interleaved'), { code: 1002 });
    if (!fin) {
      this.frag = { opcode, parts: [payload], size: payload.length };
      return true;
    }
    this._message(opcode, payload);
    return true;
  }

  _message(opcode, data) {
    if (opcode === 0x1) {
      const text = data.toString('utf8');
      if (Buffer.byteLength(text) !== data.length && text.includes('�')) {
        this.close(1007, 'invalid utf8');
        return;
      }
      this.emit('message', text, false);
    } else {
      this.emit('message', data, true);
    }
  }

  _send(opcode, payload) {
    if (this.socket.destroyed) return;
    const len = payload.length;
    let header;
    if (len < 126) header = Buffer.from([0x80 | opcode, len]);
    else if (len < 65536) {
      header = Buffer.alloc(4);
      header[0] = 0x80 | opcode;
      header[1] = 126;
      header.writeUInt16BE(len, 2);
    } else {
      header = Buffer.alloc(10);
      header[0] = 0x80 | opcode;
      header[1] = 127;
      header.writeUInt32BE(0, 2);
      header.writeUInt32BE(len, 6);
    }
    try { this.socket.write(Buffer.concat([header, payload])); } catch { /* weg */ }
  }

  /** Text senden (Objekte als JSON) */
  send(data) {
    if (this.closed || this.closeSent) return;
    const payload = Buffer.from(typeof data === 'string' ? data : JSON.stringify(data), 'utf8');
    this._send(0x1, payload);
  }

  ping() {
    if (!this.closed && !this.closeSent) this._send(0x9, Buffer.alloc(0));
  }

  /** Sauber schliessen (Close-Frame), Socket nach kurzer Zeit hart zu */
  close(code = 1000, reason = '') {
    if (this.closed || this.closeSent) return;
    this.closeSent = true;
    const r = Buffer.from(String(reason).slice(0, 120), 'utf8');
    const p = Buffer.alloc(2 + r.length);
    p.writeUInt16BE(code, 0);
    r.copy(p, 2);
    this._send(0x8, p);
    setTimeout(() => { try { this.socket.destroy(); } catch { /* egal */ } }, 2000).unref?.();
    try { this.socket.end(); } catch { /* egal */ }
    this._gone(code, reason);
  }

  _gone(code, reason) {
    if (this.closed) return;
    this.closed = true;
    this.emit('close', code, reason);
  }
}

module.exports = { acceptUpgrade, rejectUpgrade, offeredProtocols, Connection };
