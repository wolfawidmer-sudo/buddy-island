// Kleiner, sicherer Markdown-Renderer: zuerst wird alles escaped,
// danach werden nur bekannte Muster in HTML umgewandelt.
(function () {
  function escapeHtml(text) {
    return text
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function safeUrl(url) {
    return /^https?:\/\//i.test(url) ? url.replace(/"/g, '%22') : null;
  }

  // Inline-Formatierung auf bereits escaptem Text.
  function inline(text) {
    const codes = [];
    let out = text.replace(/`([^`\n]+)`/g, (_m, code) => {
      codes.push(code);
      return `\u0000${codes.length - 1}\u0000`;
    });

    out = out.replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g, (_m, label, url) => {
      const href = safeUrl(url);
      return href ? `<a href="${href}">${label}</a>` : label;
    });
    out = out.replace(/(^|[\s(])(https?:\/\/[^\s<)]+[^\s<).,;:!?])/g, (_m, pre, url) => {
      const href = safeUrl(url);
      return href ? `${pre}<a href="${href}">${url}</a>` : `${pre}${url}`;
    });
    out = out.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
    out = out.replace(/__([^_\n]+)__/g, '<strong>$1</strong>');
    out = out.replace(/(^|[^*\w])\*([^*\n]+)\*(?!\w)/g, '$1<em>$2</em>');
    out = out.replace(/(^|[^_\w])_([^_\n]+)_(?!\w)/g, '$1<em>$2</em>');
    out = out.replace(/~~([^~\n]+)~~/g, '<del>$1</del>');

    return out.replace(/\u0000(\d+)\u0000/g, (_m, i) => `<code>${codes[Number(i)]}</code>`);
  }

  function renderBlocks(text) {
    const lines = escapeHtml(text).split('\n');
    const html = [];
    let para = [];
    let list = null; // { type: 'ul' | 'ol', items: [] }

    const flushPara = () => {
      if (para.length) html.push(`<p>${inline(para.join('<br>'))}</p>`);
      para = [];
    };
    const flushList = () => {
      if (list) html.push(`<${list.type}>${list.items.map((i) => `<li>${inline(i)}</li>`).join('')}</${list.type}>`);
      list = null;
    };

    for (const raw of lines) {
      const line = raw.replace(/\s+$/, '');
      let m;
      if (!line.trim()) {
        flushPara();
        flushList();
      } else if ((m = line.match(/^\s{0,3}#{1,6}\s+(.*)$/))) {
        flushPara();
        flushList();
        html.push(`<h4>${inline(m[1])}</h4>`);
      } else if (/^\s{0,3}([-*_])(\s*\1){2,}\s*$/.test(line)) {
        flushPara();
        flushList();
        html.push('<hr>');
      } else if ((m = line.match(/^\s{0,3}&gt;\s?(.*)$/))) {
        flushPara();
        flushList();
        html.push(`<blockquote>${inline(m[1])}</blockquote>`);
      } else if ((m = line.match(/^\s*[-*+]\s+(.*)$/))) {
        flushPara();
        if (!list || list.type !== 'ul') { flushList(); list = { type: 'ul', items: [] }; }
        list.items.push(m[1]);
      } else if ((m = line.match(/^\s*\d+[.)]\s+(.*)$/))) {
        flushPara();
        if (!list || list.type !== 'ol') { flushList(); list = { type: 'ol', items: [] }; }
        list.items.push(m[1]);
      } else if (list && /^\s{2,}\S/.test(line)) {
        list.items[list.items.length - 1] += ' ' + line.trim();
      } else {
        flushList();
        para.push(line);
      }
    }
    flushPara();
    flushList();
    return html.join('');
  }

  // Kleine Syntax-Hervorhebung: arbeitet auf dem Rohtext und escaped jedes Stück selbst.
  // Kennt Kommentare, Zeichenketten, Zahlen und Schlüsselwörter der gängigen Sprachen.
  const KEYWORDS = new Set(('if else elif for while do switch case break continue return function def class const let var new this self ' +
    'import from export default as async await try catch except finally raise throw in of is not and or null None true false True False ' +
    'public private protected static void int float double bool boolean string char long struct enum interface type extends implements ' +
    'package fn pub mut impl use mod match loop where go func defer chan select range yield lambda with pass global nonlocal echo then fi done ' +
    'SELECT FROM WHERE INSERT INTO UPDATE DELETE CREATE TABLE JOIN ON GROUP BY ORDER LIMIT AND OR NOT NULL VALUES SET').split(' '));
  const HASH_COMMENT = /^(py|python|sh|bash|zsh|shell|ps1|powershell|yaml|yml|toml|r|rb|ruby|pl|perl|dockerfile|make|makefile|ini|conf)$/i;
  function highlight(code, lang) {
    if (code.length > 60000) return escapeHtml(code);
    const hash = HASH_COMMENT.test(lang || '');
    const sql = /^sql$/i.test(lang || '');
    const re = new RegExp([
      '(\\/\\*[\\s\\S]*?(?:\\*\\/|$)|\\/\\/[^\\n]*' + (hash ? '|#[^\\n]*' : '') + (sql ? '|--[^\\n]*' : '') + ')',
      '("(?:[^"\\\\\\n]|\\\\.)*"?|\'(?:[^\'\\\\\\n]|\\\\.)*\'?|`(?:[^`\\\\]|\\\\.)*`?)',
      '(\\b\\d+(?:\\.\\d+)?(?:e[+-]?\\d+)?\\b|\\b0x[\\da-f]+\\b)',
      '([A-Za-z_][\\w]*)',
    ].join('|'), 'gi');
    let out = '';
    let last = 0;
    let m;
    while ((m = re.exec(code))) {
      if (m.index > last) out += escapeHtml(code.slice(last, m.index));
      const piece = escapeHtml(m[0]);
      if (m[1]) out += `<span class="hl-c">${piece}</span>`;
      else if (m[2]) out += `<span class="hl-s">${piece}</span>`;
      else if (m[3]) out += `<span class="hl-n">${piece}</span>`;
      else if (m[4] && KEYWORDS.has(m[4])) out += `<span class="hl-k">${piece}</span>`;
      else out += piece;
      last = re.lastIndex;
      if (m[0] === '') re.lastIndex += 1;
    }
    if (last < code.length) out += escapeHtml(code.slice(last));
    return out;
  }

  function render(text) {
    const parts = [];
    const fence = /```([\w+#.-]*)[^\n]*\n([\s\S]*?)(```|$)/g;
    let last = 0;
    let m;
    while ((m = fence.exec(text))) {
      if (m.index > last) parts.push(renderBlocks(text.slice(last, m.index)));
      const lang = escapeHtml(m[1] || '');
      const code = highlight(m[2].replace(/\n$/, ''), m[1] || '');
      parts.push(
        `<div class="codeblock">${lang ? `<span class="lang">${lang}</span>` : ''}` +
        `<button type="button" class="copy">Kopieren</button><pre><code>${code}</code></pre></div>`,
      );
      last = fence.lastIndex;
      if (m[3] === '') break; // Codeblock noch nicht geschlossen (Stream läuft)
    }
    if (last < text.length) parts.push(renderBlocks(text.slice(last)));
    return parts.join('');
  }

  window.renderMarkdown = render;
  window.highlightCode = highlight;
})();
