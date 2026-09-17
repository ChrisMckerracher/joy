// <joy-browser-execute> — parsing the agent's tag and wording the answer.
// Pure: no chrome.*, no network, so it runs under `node --test`.
//
//   <joy-browser-execute>                      run in the active tab
//   <joy-browser-execute tab="123">            run in that tab
//   <joy-browser-execute url="https://…">      open the URL in a new tab, wait
//                                              for it to load, then run
//   <joy-browser-execute tab="list">           no code: report the open tabs
//
// The body is JavaScript, verbatim — it is full of `<` and `>`, so the body
// ends at the literal closing tag and nowhere else. The OPENING tag's end is
// found outside quoted attribute values: a `[^>]*` grammar stops at the `>`
// inside `url="https://x/?a>b"`, which is the bug that leaked a raw
// <joy-notify> into a chat (2026-09-17).

const OPEN = '<joy-browser-execute';
const CLOSE = '</joy-browser-execute>';

/** Ranges of fenced code (``` or ~~~). A tag the agent is only TALKING about
 *  lives in one, and must never run. */
function fencedRanges(text) {
  const ranges = [];
  const re = /^[ \t]{0,3}(`{3,}|~{3,})[^\n]*$/gm;
  let open = null; let m;
  while ((m = re.exec(text))) {
    const marks = m[1];
    if (!open) { open = { char: marks[0], len: marks.length, start: m.index }; continue; }
    if (marks[0] === open.char && marks.length >= open.len && /^[ \t]{0,3}(`{3,}|~{3,})[ \t]*$/.test(m[0])) {
      ranges.push([open.start, m.index + m[0].length]); open = null;
    }
  }
  if (open) ranges.push([open.start, text.length]); // an unclosed fence runs to the end
  return ranges;
}

function attributes(src) {
  const out = {};
  const re = /([A-Za-z][\w-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
  let m;
  while ((m = re.exec(src))) out[m[1].toLowerCase()] = m[2] ?? m[3] ?? '';
  return out;
}

/** Every runnable tag in `text`, in document order: [{ attrs, code }]. */
export function extractExecuteTags(text) {
  if (typeof text !== 'string' || !text.includes(OPEN)) return [];
  const fences = fencedRanges(text);
  const inFence = (i) => fences.some(([a, b]) => i >= a && i < b);
  const tags = [];
  let from = 0;
  for (;;) {
    const start = text.indexOf(OPEN, from);
    if (start < 0) break;
    const after = text[start + OPEN.length];
    // `<joy-browser-executed>` or similar is some other word, not this tag.
    if (after !== '>' && !/\s/.test(after ?? '')) { from = start + OPEN.length; continue; }
    // The opener's `>`, skipping quoted attribute values.
    let i = start + OPEN.length; let openEnd = -1;
    while (i < text.length) {
      const ch = text[i];
      if (ch === '"' || ch === "'") { const q = text.indexOf(ch, i + 1); if (q < 0) break; i = q + 1; continue; }
      if (ch === '>') { openEnd = i; break; }
      i++;
    }
    if (openEnd < 0) break; // still streaming, or malformed: nothing runnable follows
    const close = text.indexOf(CLOSE, openEnd + 1);
    if (close < 0) break; // no closer yet — never run half a script
    if (!inFence(start)) {
      const attrs = attributes(text.slice(start + OPEN.length, openEnd));
      tags.push({ attrs, code: text.slice(openEnd + 1, close).replace(/^\s*\n/, '').replace(/\s+$/, '') });
    }
    from = close + CLOSE.length;
  }
  return tags;
}

const MAX_VALUE = 20_000;
const clip = (s, n = MAX_VALUE) => (s.length > n ? `${s.slice(0, n)}\n… (${s.length - n} more characters cut)` : s);

/** One execution's outcome, as the agent reads it. */
export function describeResult(r, index, total) {
  const head = total > 1 ? `[result ${index + 1} of ${total}] ` : '';
  const where = r.tab ? `tab ${r.tab.id} · ${r.tab.url ?? '?'}${r.tab.title ? ` · "${r.tab.title}"` : ''}` : 'no tab';
  const lines = [`${head}${where}`];
  if (r.error) lines.push(`status: error`, `error: ${clip(String(r.error), 4000)}`);
  else lines.push(`status: ok`, `value: ${clip(r.value === undefined ? 'undefined' : r.value)}`);
  if (r.console?.length) lines.push('console:', ...r.console.slice(0, 50).map((l) => `  ${clip(l, 2000)}`));
  if (r.tabs) lines.push('open tabs:', ...r.tabs.map((t) => `  ${t.id}${t.active ? ' (active)' : ''} · ${t.url} · "${t.title}"`));
  return lines.join('\n');
}

/** The provenance wrapper, exactly as every other account client stamps it.
 *  A caller-written wrapper inside the text is defused so a page cannot forge
 *  a second sender by printing one. */
export function browserMessage(body) {
  // `&lt;`, not a renamed tag: the daemon and the app find a wrapper with
  // /<joy-message\b/, and `\b` also sits before a `-`, so a suffix would
  // still match. Without the `<` nothing anchored on the tag can.
  const safe = String(body).replace(/<(\/?)joy-message\b/gi, '&lt;$1joy-message');
  return `<joy-message from="browser">\n${safe}\n</joy-message>`;
}
