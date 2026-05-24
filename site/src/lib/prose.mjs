// Minimal, safe markdown renderer for LLM-authored editorial prose.
//
// The model emits inline markdown (**bold**, *italic*, [links](url), `code`) in
// fields like the_full_read / why_it_matters / faq answers, but the template was
// interpolating them as plain text, so readers saw literal "**₹354.83 lakh**".
//
// Safety: the whole string is HTML-escaped FIRST, then only a fixed set of
// formatting tags is reintroduced around already-escaped text. So even if the
// model emits raw HTML/script, set:html on the result cannot inject live markup.

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

// Inline emphasis, links and code on a single run of text. Returns an HTML string.
export function renderInline(text) {
  let s = escapeHtml(text);
  // [label](url) — only http(s) or root-relative hrefs; anything else falls back
  // to the bare label so a stray "(" can't produce a junk/unsafe link.
  s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_, label, url) => {
    const href = url.replace(/&amp;/g, '&');
    if (!/^(https?:\/\/|\/)/i.test(href)) return label;
    const external = /^https?:/i.test(href);
    return `<a href="${escapeHtml(href)}"${external ? ' target="_blank" rel="noopener"' : ''}>${label}</a>`;
  });
  s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');        // **bold**
  s = s.replace(/__([^_]+)__/g, '<strong>$1</strong>');            // __bold__
  s = s.replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, '$1<em>$2</em>');   // *italic* (not **)
  s = s.replace(/`([^`]+)`/g, '<code>$1</code>');                  // `code`
  return s;
}

// Block-level prose: each newline-separated chunk becomes a paragraph (matching
// the previous split on /\n+/), with inline markdown rendered inside. Bullet
// runs ("- " / "* ") collapse into a <ul>.
export function renderProse(text) {
  const chunks = String(text || '').replace(/\r\n/g, '\n').split(/\n+/).map(c => c.trim()).filter(Boolean);
  const out = [];
  let list = null;
  for (const chunk of chunks) {
    const bullet = chunk.match(/^[-*]\s+(.*)$/);
    if (bullet) {
      (list ??= []).push(`<li>${renderInline(bullet[1])}</li>`);
      continue;
    }
    if (list) { out.push(`<ul>${list.join('')}</ul>`); list = null; }
    out.push(`<p>${renderInline(chunk)}</p>`);
  }
  if (list) out.push(`<ul>${list.join('')}</ul>`);
  return out.join('\n');
}
