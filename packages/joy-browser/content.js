// Joy Browser — the page button and its chat panel.
//
// A content script cannot import, so this file stands alone. It holds no keys
// and does no crypto: it draws what the background sends and hands back what
// you type. Everything sits in a CLOSED shadow root, so the page's styles do
// not leak in and the page's scripts cannot read the conversation out. Agent
// and page text is only ever set with textContent — never parsed as HTML.
(() => {
  if (window.top !== window || window.__joyBrowserLoaded) return;
  window.__joyBrowserLoaded = true;
  const api = globalThis.browser ?? globalThis.chrome;
  const COARSE = matchMedia('(pointer: coarse)').matches;
  const FAB = COARSE ? 54 : 46; const PANEL_W = 370; const PANEL_H = 540; const EDGE = COARSE ? 16 : 12;
  // A phone, by its physical screen (in CSS px, portrait width): the panel is a
  // sheet there. A page with no viewport meta is laid out ~980px wide on a phone
  // and shown zoomed out, which would shrink the widget to a thumbnail — `z`
  // is the zoom that undoes that (1 on a page that fits its screen).
  const PHONE = COARSE && Math.min(screen.width, screen.height) < 520;
  const screenW = () => (matchMedia('(orientation: portrait)').matches ? Math.min(screen.width, screen.height) : Math.max(screen.width, screen.height));
  const layoutW = () => document.documentElement.clientWidth || innerWidth; // stable under pinch-zoom, unlike innerWidth on iOS
  const layoutH = () => document.documentElement.clientHeight || innerHeight;
  const zoom = () => (PHONE ? Math.max(1, layoutW() / screenW()) : 1);
  const narrow = () => PHONE || innerWidth < 520; // a small window on a desktop is a sheet too

  let host = null; let shadow = null; let fab = null; let panel = null; let list = null; let input = null; let statusEl = null; let pendingEl = null; let titleEl = null; let pauseBtn = null;
  let port = null; let open = false; let pos = null; let ping = null;
  let retry = null; let lastHeard = 0; let transportError = null; let sendError = null; let pendingSend = null; let sending = false; let sendBtn = null; let sendTimer = null;
  const view = { rows: [], working: false, session: null, paused: false, pending: [], linkError: null };

  const el = (tag, props = {}, ...kids) => { const n = Object.assign(document.createElement(tag), props); for (const k of kids) if (k != null) n.append(k); return n; };
  const ask = (msg) => { try { return Promise.resolve(api.runtime.sendMessage(msg)).catch(() => null); } catch { return Promise.resolve(null); } };

  const CSS = `
    :host { all: initial; }
    * { box-sizing: border-box; }
    .fab { position: fixed; width: ${FAB}px; height: ${FAB}px; -webkit-tap-highlight-color: transparent; border-radius: 50%; border: 0; cursor: grab; z-index: 2147483647; display: grid; place-items: center;
      background: #16161a; color: #fff; box-shadow: 0 4px 14px rgba(0,0,0,.35), 0 0 0 1px rgba(255,255,255,.14) inset; font: 600 17px/1 -apple-system, system-ui, sans-serif; touch-action: none; user-select: none; }
    .fab:active { cursor: grabbing; }
    .fab .dot { position: absolute; right: 2px; top: 2px; width: 11px; height: 11px; border-radius: 50%; border: 2px solid #16161a; background: #32d158; }
    .fab.working .dot { background: #ffd60a; animation: pulse 1.1s ease-in-out infinite; }
    .fab.paused .dot { background: #8e8e93; } .fab.error .dot { background: #ff453a; }
    @keyframes pulse { 50% { opacity: .35; } }
    .panel { position: fixed; width: ${PANEL_W}px; height: ${PANEL_H}px; max-width: calc(100vw - ${EDGE * 2}px); max-height: calc(100vh - ${EDGE * 2}px); z-index: 2147483646; display: none; flex-direction: column;
      border-radius: 14px; overflow: hidden; font: 13px/1.45 -apple-system, system-ui, 'Segoe UI', sans-serif; color: var(--fg); background: var(--bg); box-shadow: 0 12px 40px rgba(0,0,0,.35), 0 0 0 1px var(--line);
      --fg: #1d1d1f; --dim: #6e6e73; --bg: #ffffff; --card: #f2f2f4; --line: rgba(0,0,0,.12); --accent: #0a66d8; --mine: #0a66d8; --ok: #1d8a3a; --bad: #c4271b; }
    @media (prefers-color-scheme: dark) { .panel { --fg: #f5f5f7; --dim: #a1a1a6; --bg: #1c1c1e; --card: #2c2c2e; --line: rgba(255,255,255,.14); --accent: #4c9bff; --mine: #2f6fd6; --ok: #32d158; --bad: #ff6961; } }
    .panel.open { display: flex; }
    header { display: flex; align-items: center; gap: 8px; padding: 10px 12px; border-bottom: 1px solid var(--line); }
    header .t { flex: 1; min-width: 0; font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    header .s { font-weight: 400; color: var(--dim); font-size: 11px; display: block; }
    button { font: inherit; color: inherit; cursor: pointer; }
    .hbtn { border: 1px solid var(--line); background: var(--card); border-radius: 7px; padding: 3px 8px; font-size: 11px; }
    .list { flex: 1; overflow-y: auto; padding: 12px; display: flex; flex-direction: column; gap: 8px; overscroll-behavior: contain; }
    .row { max-width: 92%; white-space: pre-wrap; overflow-wrap: anywhere; }
    .user { align-self: flex-end; background: var(--mine); color: #fff; border-radius: 13px 13px 3px 13px; padding: 7px 11px; }
    .agent { align-self: flex-start; display: flex; flex-direction: column; gap: 6px; }
    .tool { align-self: flex-start; color: var(--dim); font-size: 11px; }
    .chip { align-self: flex-start; max-width: 100%; border: 1px solid var(--line); background: var(--card); border-radius: 9px; font-size: 12px; overflow: hidden; }
    .chip > summary { cursor: pointer; padding: 5px 9px; list-style: none; color: var(--dim); } .chip > summary::-webkit-details-marker { display: none; }
    .chip.ok > summary { color: var(--ok); } .chip.bad > summary { color: var(--bad); }
    .prose { display: grid; gap: 6px; white-space: pre-wrap; overflow-wrap: anywhere; } .prose code { font: 12px ui-monospace, Menlo, Consolas, monospace; background: var(--card); border-radius: 4px; padding: 1px 4px; }
    .prose pre { margin: 0; padding: 8px 9px; background: var(--card); border-radius: 8px; font: 11px/1.4 ui-monospace, Menlo, Consolas, monospace; white-space: pre-wrap; overflow-wrap: anywhere; max-height: 220px; overflow: auto; }
    textarea::-webkit-scrollbar { display: none; }
    /* A phone: the panel is a sheet from the bottom, the whole width, above the
       keyboard (--kb follows visualViewport). Inline left/top from place() lose. */
    .panel.sheet { left: 0 !important; top: auto !important; right: 0; bottom: var(--kb, 0px); width: 100%; max-width: 100%; height: min(${PANEL_H}px, 100% - 56px); max-height: calc(100% - 56px);
      border-radius: 16px 16px 0 0; padding-bottom: env(safe-area-inset-bottom, 0px); }
    .panel.sheet form { padding-bottom: calc(10px + env(safe-area-inset-bottom, 0px)); }
    .panel.sheet.open + .fab { display: none; } /* the sheet covers the button's corner; ✕ closes */
    .panel.sheet header { flex-wrap: wrap; } .panel.sheet header .t { flex: 1 1 100%; } .panel.sheet header .hbtn:first-of-type { margin-left: auto; }
    @media (pointer: coarse) {
      .panel { font-size: 15px; }
      textarea { font-size: 16px; min-height: 42px; } /* under 16px, iOS zooms the page on focus */
      .hbtn, .card .a button, .opts button, .send { min-height: 36px; padding: 6px 12px; font-size: 14px; }
      .chip > summary { padding: 8px 11px; } .chip { font-size: 14px; }
      header { padding: 12px 14px; } header .s { font-size: 12px; }
    }
    .chip pre { margin: 0; padding: 8px 9px; border-top: 1px solid var(--line); font: 11px/1.4 ui-monospace, Menlo, Consolas, monospace; white-space: pre-wrap; overflow-wrap: anywhere; max-height: 180px; overflow: auto; color: var(--fg); }
    .opts { display: flex; flex-wrap: wrap; gap: 6px; } .opts button { border: 1px solid var(--accent); color: var(--accent); background: transparent; border-radius: 999px; padding: 4px 11px; }
    .status { padding: 0 12px 6px; color: var(--dim); font-size: 11px; min-height: 17px; } .status.bad { color: var(--bad); }
    .pending { border-top: 1px solid var(--line); padding: 8px 12px; display: none; flex-direction: column; gap: 8px; max-height: 190px; overflow-y: auto; } .pending.on { display: flex; }
    .card { border: 1px solid var(--line); border-radius: 10px; padding: 8px 10px; display: grid; gap: 5px; background: var(--card); }
    .card b { font-weight: 600; } .card .m { color: var(--dim); font-size: 11px; } .card .a { display: flex; gap: 6px; }
    .card .a button { border-radius: 7px; border: 1px solid var(--line); padding: 3px 10px; background: var(--bg); } .card .a .yes { background: var(--accent); border-color: var(--accent); color: #fff; }
    form { display: flex; gap: 8px; padding: 10px 12px; border-top: 1px solid var(--line); align-items: flex-end; }
    textarea { flex: 1; resize: none; overflow-y: auto; scrollbar-width: none; font: inherit; color: var(--fg); background: var(--card); border: 1px solid var(--line); border-radius: 10px; padding: 8px 10px; max-height: 120px; min-height: 36px; outline: none; }
    textarea:focus { border-color: var(--accent); }
    .send { border: 0; border-radius: 10px; background: var(--accent); color: #fff; padding: 8px 13px; height: 36px; } .send:disabled { opacity: .45; cursor: default; }
  `;

  // ── drawing the conversation ──
  function chip(cls, summary, body) {
    const d = el('details', { className: `chip ${cls}` }, el('summary', { textContent: summary }));
    if (body) d.append(el('pre', { textContent: body }));
    return d;
  }
  // Just enough markdown to read an agent comfortably: fenced code, `code`,
  // **bold**. Built from text nodes only — a reply never becomes HTML.
  function inline(parent, text) {
    for (const part of text.split(/(`[^`\n]+`|\*\*[^*\n]+\*\*)/)) {
      if (!part) continue;
      if (part.length > 2 && part.startsWith('`') && part.endsWith('`')) parent.append(el('code', { textContent: part.slice(1, -1) }));
      else if (part.length > 4 && part.startsWith('**') && part.endsWith('**')) parent.append(el('b', { textContent: part.slice(2, -2) }));
      else parent.append(part);
    }
  }
  function prose(text) {
    const box = el('div', { className: 'prose' });
    text.split(/(```[^\n]*\n[\s\S]*?(?:```|$))/).forEach((part, i) => {
      if (i % 2) box.append(el('pre', { textContent: part.replace(/^```[^\n]*\n/, '').replace(/\n?```$/, '') }));
      else if (part.trim()) inline(box.appendChild(el('div')), part.trim());
    });
    return box;
  }
  function drawRow(r) {
    if (r.role === 'user') return el('div', { className: 'row user', textContent: r.text });
    if (r.role === 'tool') return el('div', { className: 'tool', textContent: `· ${r.text}` });
    if (r.role === 'browser') return chip(r.ok ? 'ok' : 'bad', r.ok ? '✓ the browser answered' : '✕ the browser reported an error', r.text);
    const wrap = el('div', { className: 'row agent' });
    for (const s of r.segments ?? []) {
      if (s.t === 'text') wrap.append(prose(s.text));
      else if (s.t === 'script') wrap.append(chip('', `▸ ran a script — ${s.where}`, s.code || '(no script: just opening the page)'));
      else if (s.t === 'remember') wrap.append(chip('', `▸ asked to save "${s.name}" for ${s.match.join(', ') || '?'}`, s.code));
      else if (s.t === 'options') {
        const o = el('div', { className: 'opts' });
        for (const item of s.items) { const b = el('button', { type: 'button', textContent: item }); b.onclick = () => send(item); o.append(b); }
        wrap.append(o);
      }
    }
    return wrap;
  }
  function drawAll() {
    if (!list) return;
    const pinned = list.scrollHeight - list.scrollTop - list.clientHeight < 60;
    list.replaceChildren(...view.rows.map(drawRow));
    if (!view.rows.length) list.append(el('div', { className: 'tool', textContent: view.session ? 'Say what you want done in this browser.' : 'No session is linked yet — open the extension to finish setup.' }));
    if (pinned) list.scrollTop = list.scrollHeight;
  }
  function drawMeta() {
    if (!panel) return;
    titleEl.replaceChildren(view.session?.title ?? (view.session ? `session ${view.session.localId}` : 'Joy Browser'), el('span', { className: 's', textContent: view.session ? `${view.session.localId}${view.session.machine ? ` · ${view.session.machine}` : ''}` : 'not linked' }));
    pauseBtn.textContent = view.paused ? 'Resume' : 'Pause';
    const error = transportError || sendError || view.linkError;
    statusEl.className = `status${error ? ' bad' : ''}`;
    statusEl.textContent = error ? error : sending ? 'Sending…' : view.paused ? 'Paused — the agent cannot run anything in this browser.' : view.working ? 'working…' : '';
    fab.className = `fab${error ? ' error' : view.paused ? ' paused' : view.working ? ' working' : ''}`;
    if (sendBtn) sendBtn.disabled = sending;
    pendingEl.className = `pending${view.pending.length ? ' on' : ''}`;
    pendingEl.replaceChildren(...view.pending.map((s) => {
      const yes = el('button', { type: 'button', className: 'yes', textContent: 'Approve' }); const no = el('button', { type: 'button', textContent: 'Reject' });
      yes.onclick = () => tell({ type: 'script', id: s.id, revision: s.revision, approve: true });
      no.onclick = () => tell({ type: 'script', id: s.id, revision: s.revision, approve: false });
      return el('div', { className: 'card' }, el('div', {}, 'The agent wants to save ', el('b', { textContent: s.name })), el('div', { className: 'm', textContent: `Runs on every visit to: ${s.match.join(', ')}` }), chip('', 'show the script', s.code), el('div', { className: 'a' }, yes, no));
    }));
  }

  // ── talking to the background ──
  function disconnected(p) {
    if (port !== p) return;
    port = null; sending = false; clearTimeout(sendTimer);
    transportError = 'Disconnected — reconnecting. Unsent text stays here.'; drawMeta();
    clearTimeout(retry);
    if (open) retry = setTimeout(() => { if (open) connect(); }, 600);
  }
  function tell(message) {
    if (!port) { transportError = 'Disconnected — reconnecting. Try again when connected.'; connect(); drawMeta(); return false; }
    const p = port;
    try { p.postMessage(message); return true; }
    catch { disconnected(p); try { p.disconnect(); } catch { /* gone */ } return false; }
  }
  function connect() {
    if (port || !host) return;
    clearTimeout(retry);
    let p;
    try { p = api.runtime.connect({ name: 'joy-chat' }); }
    catch { disconnected(null); return; }
    port = p; lastHeard = Date.now();
    transportError = 'Connecting…'; drawMeta();
    p.onMessage.addListener((m) => {
      if (port !== p) return;
      lastHeard = Date.now(); transportError = null;
      if (m.type === 'state' || m.type === 'meta') {
        const changed = view.session?.sessionId !== m.session?.sessionId;
        if (changed) { view.rows = []; pendingSend = null; sending = false; clearTimeout(sendTimer); view.working = false; }
        Object.assign(view, { session: m.session, paused: !!m.paused, pending: m.pending ?? [], linkError: m.linkError ?? null });
        if (m.type === 'state') { view.rows = m.rows ?? []; view.working = !!m.working; }
        drawAll();
        if (changed && list) list.scrollTop = list.scrollHeight;
      } else if (m.type === 'rows') {
        if (m.sessionId && m.sessionId !== view.session?.sessionId) return;
        const seen = new Set(view.rows.map((r) => r.seq));
        for (const r of m.rows ?? []) if (!seen.has(r.seq)) { view.rows.push(r); seen.add(r.seq); }
        view.rows.sort((a, b) => a.seq - b.seq); view.rows = view.rows.slice(-300);
        view.working = !!m.working; drawAll();
      } else if (m.type === 'sent' && pendingSend?.id === m.id) {
        if (input?.value.trim() === pendingSend.text) { input.value = ''; input.style.height = 'auto'; }
        pendingSend = null; sending = false; sendError = null; clearTimeout(sendTimer);
      } else if (m.type === 'error') {
        if (!m.id) view.linkError = m.message;
        else if (pendingSend?.id === m.id) { sendError = m.message; sending = false; clearTimeout(sendTimer); }
      } else if (m.type === 'gone') { teardown(); return; }
      drawMeta();
    });
    p.onDisconnect.addListener(() => { void api.runtime.lastError; disconnected(p); });
    tell({ type: 'hello' });
  }
  function send(text) {
    const t = String(text).trim();
    if (!t || sending) return;
    // Keep the same intent on an ambiguous retry (e.g. the worker died after
    // acceptance). The relay deduplicates it; a changed draft is a new intent.
    if (!pendingSend || pendingSend.text !== t) pendingSend = { id: crypto.randomUUID?.() ?? Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, '0')).join(''), text: t };
    if (input && !input.value.trim()) input.value = t; // option buttons also retain a failed draft
    sendError = null; sending = tell({ type: 'send', ...pendingSend }); drawMeta();
    clearTimeout(sendTimer);
    if (sending) sendTimer = setTimeout(() => { sending = false; sendError = 'Delivery is not confirmed. Your text is saved here; try Send again.'; drawMeta(); }, 45_000);
  }

  // ── the button: drag it anywhere, click it to talk ──
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
  function place() {
    if (!fab) return;
    // Everything below is in the widget's own px: the layout viewport divided by the zoom that undoes a zoomed-out page.
    const z = zoom(); const W = layoutW() / z; const H = layoutH() / z;
    fab.style.zoom = panel.style.zoom = z === 1 ? '' : String(z);
    // Keep the button above the bottom of the visible page, where a phone browser's own bar sits.
    const bottom = EDGE + (COARSE ? 44 : 0);
    const x = clamp((pos?.x ?? 1) * W - FAB / 2, EDGE, W - FAB - EDGE);
    const y = clamp((pos?.y ?? 1) * H - FAB / 2, EDGE, H - FAB - bottom);
    fab.style.left = `${x}px`; fab.style.top = `${y}px`;
    panel.classList.toggle('sheet', narrow());
    if (narrow()) {
      // The keyboard shrinks the visual viewport, not the layout one: lift the sheet by the difference.
      const vv = visualViewport;
      panel.style.setProperty('--kb', `${vv ? Math.max(0, (layoutH() - vv.height - vv.offsetTop) / z) : 0}px`);
      return;
    }
    // The panel opens toward whichever side of the button has room.
    const left = x + FAB / 2 > innerWidth / 2 ? x + FAB - PANEL_W : x;
    const top = y + FAB / 2 > innerHeight / 2 ? y - PANEL_H - 10 : y + FAB + 10;
    panel.style.left = `${clamp(left, EDGE, Math.max(EDGE, innerWidth - PANEL_W - EDGE))}px`;
    panel.style.top = `${clamp(top, EDGE, Math.max(EDGE, innerHeight - PANEL_H - EDGE))}px`;
  }
  function toggle(next = !open) {
    clearInterval(ping); ping = null;
    open = next; panel.classList.toggle('open', open);
    if (open) { connect(); place(); setTimeout(() => input?.focus(), 0); ping = setInterval(() => {
      if (port && Date.now() - lastHeard > 45_000) { const p = port; disconnected(p); try { p.disconnect(); } catch { /* gone */ } }
      if (!port) connect(); else tell({ type: 'ping' });
    }, 20_000); }
    else { clearInterval(ping); ping = null; }
  }

  function build(st) {
    if (host) return;
    pos = st.fab ?? null; view.paused = !!st.paused;
    host = el('joy-browser-root'); host.style.cssText = 'all: initial; position: fixed; top: 0; left: 0; width: 0; height: 0; z-index: 2147483647;';
    shadow = host.attachShadow({ mode: 'closed' });
    fab = el('button', { className: 'fab', type: 'button', title: 'Joy — talk to your session' }, 'J', el('span', { className: 'dot' }));
    titleEl = el('div', { className: 't' });
    pauseBtn = el('button', { className: 'hbtn', type: 'button' }); pauseBtn.onclick = () => tell({ type: 'pause', paused: !view.paused });
    const hide = el('button', { className: 'hbtn', type: 'button', textContent: 'Hide on this site', title: 'Adds this site to Excluded sites: no button here, and the agent cannot run scripts here.' });
    hide.onclick = () => tell({ type: 'hideHere', host: location.hostname }); // storage change hides it after success
    const close = el('button', { className: 'hbtn', type: 'button', textContent: '✕' }); close.onclick = () => toggle(false);
    list = el('div', { className: 'list' }); statusEl = el('div', { className: 'status' }); pendingEl = el('div', { className: 'pending' });
    input = el('textarea', { rows: 1, placeholder: 'Message your session…' });
    sendBtn = el('button', { className: 'send', type: 'submit', textContent: 'Send' });
    const form = el('form', {}, input, sendBtn);
    const submit = () => send(input.value);
    form.onsubmit = (e) => { e.preventDefault(); submit(); };
    input.onkeydown = (e) => { e.stopPropagation(); if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); submit(); } };
    input.onkeyup = input.onkeypress = (e) => e.stopPropagation(); // a page's own hotkeys must not fire while you type
    input.oninput = () => { input.style.height = 'auto'; input.style.height = `${Math.min(120, input.scrollHeight)}px`; };
    panel = el('div', { className: 'panel' }, el('header', {}, titleEl, pauseBtn, hide, close), list, pendingEl, statusEl, form);
    shadow.append(el('style', { textContent: CSS }), panel, fab);

    let drag = null;
    fab.onpointerdown = (e) => { drag = { x: e.clientX, y: e.clientY, moved: false }; fab.setPointerCapture(e.pointerId); };
    fab.onpointermove = (e) => {
      if (!drag) return;
      if (!drag.moved && Math.hypot(e.clientX - drag.x, e.clientY - drag.y) < 5) return;
      drag.moved = true; pos = { x: clamp(e.clientX / layoutW(), 0, 1), y: clamp(e.clientY / layoutH(), 0, 1) }; place();
    };
    fab.onpointerup = (e) => { const d = drag; drag = null; try { fab.releasePointerCapture(e.pointerId); } catch { /* already released */ } if (!d) return; if (d.moved) void ask({ type: 'fab:save', ...pos }); else toggle(); };
    addEventListener('resize', place); visualViewport?.addEventListener('resize', place); visualViewport?.addEventListener('scroll', place);
    (document.body ?? document.documentElement).append(host);
    place(); drawMeta(); drawAll();
    connect(); // the dot on the button is live even with the panel shut
  }
  function teardown() {
    clearInterval(ping); clearTimeout(retry); clearTimeout(sendTimer); ping = retry = null; open = false;
    try { port?.disconnect(); } catch { /* gone */ } port = null;
    removeEventListener('resize', place); visualViewport?.removeEventListener('resize', place); visualViewport?.removeEventListener('scroll', place);
    host?.remove(); host = shadow = fab = panel = list = input = sendBtn = null;
    view.rows = []; view.session = null; view.working = false; pendingSend = null; sending = false;
  }

  let syncId = 0;
  async function sync() {
    const id = ++syncId;
    const st = await ask({ type: 'pageState', url: location.href });
    if (id !== syncId || !st || st.error) return;
    if (st?.show) build(st); else teardown();
  }
  // Setup finishing, a site being excluded, everything being cleared: the button follows.
  api.storage.onChanged.addListener((changes, area) => { if (area === 'local' && (changes.setup || changes.excluded)) void sync(); });
  void sync();
})();
