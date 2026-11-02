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

  function render(text) {
    const parts = [];
    const fence = /```([\w+#.-]*)[^\n]*\n([\s\S]*?)(```|$)/g;
    let last = 0;
    let m;
    while ((m = fence.exec(text))) {
      if (m.index > last) parts.push(renderBlocks(text.slice(last, m.index)));
      const lang = escapeHtml(m[1] || '');
      const code = escapeHtml(m[2].replace(/\n$/, ''));
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
})();
