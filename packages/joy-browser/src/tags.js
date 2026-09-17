// The agent's browser tags: finding them, wording the answer, and turning a
// reply into what the chat panel shows. Pure — runs under `node --test`.
//
//   <joy-browser-execute>                      run in the active tab
//   <joy-browser-execute tab="123">            run in that tab
//   <joy-browser-execute url="https://…">      open the URL in a new tab, wait
//                                              for it to load, then run
//   <joy-browser-execute tab="list">           no code: report the open tabs
//   <joy-browser-remember name="…" match="a.com, b.com/x/*">
//                                              save a script that runs on every
//                                              visit to those sites — once the
//                                              user has approved it
//
// A body is JavaScript, verbatim — it is full of `<` and `>`, so it ends at the
// literal closing tag and nowhere else. The OPENING tag's end is found outside
// quoted attribute values: a `[^>]*` grammar stops at the `>` inside
// `url="https://x/?a>b"`, which is the bug that leaked a raw <joy-notify> into
// a chat (2026-09-17).

const KINDS = { execute: 'joy-browser-execute', remember: 'joy-browser-remember' };

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

/** The index of the `>` that ends an opening tag starting at `from`, skipping
 *  quoted attribute values; -1 when it never ends. */
function openerEnd(text, from) {
  let i = from;
  while (i < text.length) {
    const ch = text[i];
    if (ch === '"' || ch === "'") { const q = text.indexOf(ch, i + 1); if (q < 0) return -1; i = q + 1; continue; }
    if (ch === '>') return i;
    i++;
  }
  return -1;
}

/** Every runnable browser tag, in document order, with where it sits:
 *  [{ kind, attrs, code, start, end }]. Fenced, unterminated and half-streamed
 *  tags are not tags. */
export function extractBrowserTags(text) {
  if (typeof text !== 'string' || !text.includes('<joy-browser-')) return [];
  const fences = fencedRanges(text);
  const inFence = (i) => fences.some(([a, b]) => i >= a && i < b);
  const tags = [];
  let from = 0;
  for (;;) {
    let start = -1; let kind = null;
    for (const [k, name] of Object.entries(KINDS)) {
      const at = text.indexOf(`<${name}`, from);
      if (at >= 0 && (start < 0 || at < start)) { start = at; kind = k; }
    }
    if (start < 0) break;
    const open = `<${KINDS[kind]}`; const close = `</${KINDS[kind]}>`;
    const after = text[start + open.length];
    // `<joy-browser-executed>` is some other word, not this tag.
    if (after !== '>' && !/\s/.test(after ?? '')) { from = start + open.length; continue; }
    const openEnd = openerEnd(text, start + open.length);
    if (openEnd < 0) break; // still streaming, or malformed: nothing runnable follows
    const closeAt = text.indexOf(close, openEnd + 1);
    if (closeAt < 0) break; // no closer yet — never run half a script
    const end = closeAt + close.length;
    if (!inFence(start)) {
      tags.push({ kind, attrs: attributes(text.slice(start + open.length, openEnd)), code: text.slice(openEnd + 1, closeAt).replace(/^\s*\n/, '').replace(/\s+$/, ''), start, end });
    }
    from = end;
  }
  return tags;
}

/** The scripts to run now: [{ attrs, code }]. */
export const extractExecuteTags = (text) => extractBrowserTags(text).filter((t) => t.kind === 'execute').map(({ attrs, code }) => ({ attrs, code }));

/** "a.com, b.com/x/*" → ['a.com', 'b.com/x/*'] */
export const splitMatch = (s) => String(s ?? '').split(/[,\s]+/).map((p) => p.trim()).filter(Boolean);

const MAX_VALUE = 20_000;
const clip = (s, n = MAX_VALUE) => (s.length > n ? `${s.slice(0, n)}\n… (${s.length - n} more characters cut)` : s);

/** One outcome, as the agent reads it. */
export function describeResult(r, index, total) {
  const head = total > 1 ? `[result ${index + 1} of ${total}] ` : '';
  if (r.note) return `${head}${r.note}`;
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

/** A prompt that is one of OUR answers → its body, else null. */
export function browserMessageBody(text) {
  const m = /^<joy-message\b[^>]*\bfrom="browser"[^>]*>\n?([\s\S]*?)\n?<\/joy-message>\s*$/.exec(String(text ?? '').trim());
  return m ? m[1] : null;
}

// ── what the chat panel shows ────────────────────────────────────────────────

/** Control tags that mean nothing to a reader of this panel. */
function stripControlTags(text) {
  let out = ''; let from = 0;
  const re = /<joy-(title|notify|bg)\b/g;
  let m;
  while ((m = re.exec(text))) {
    const end = openerEnd(text, m.index + m[0].length);
    if (end < 0) break;
    out += text.slice(from, m.index); from = end + 1; re.lastIndex = from;
  }
  return out + text.slice(from);
}

/** An agent reply → segments for the panel: prose stays prose, a script
 *  becomes one line you can open, offered options become buttons. */
export function displaySegments(text) {
  const src = String(text ?? '');
  const segs = [];
  const prose = (s) => {
    let t = stripControlTags(s);
    const options = [];
    t = t.replace(/<joy-options>([\s\S]*?)<\/joy-options>/g, (_, body) => { for (const o of body.matchAll(/<joy-option>([\s\S]*?)<\/joy-option>/g)) options.push(o[1].trim()); return ''; });
    t = t.replace(/\n{3,}/g, '\n\n').trim();
    if (t) segs.push({ t: 'text', text: t });
    if (options.length) segs.push({ t: 'options', items: options });
  };
  let at = 0;
  for (const tag of extractBrowserTags(src)) {
    prose(src.slice(at, tag.start)); at = tag.end;
    if (tag.kind === 'execute') segs.push({ t: 'script', where: tag.attrs.url ? tag.attrs.url : tag.attrs.tab === 'list' ? 'listing the open tabs' : tag.attrs.tab ? `tab ${tag.attrs.tab}` : 'this tab', code: tag.code });
    else segs.push({ t: 'remember', name: tag.attrs.name || 'untitled script', match: splitMatch(tag.attrs.match), code: tag.code });
  }
  prose(src.slice(at));
  return segs;
}
