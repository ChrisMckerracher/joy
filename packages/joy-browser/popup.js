// The popup: pair, pick the session this browser answers to, watch it work.
const app = document.getElementById('app');
const ask = (type, extra = {}) => chrome.runtime.sendMessage({ type, ...extra });
const el = (tag, props = {}, ...kids) => {
  const n = Object.assign(document.createElement(tag), props);
  for (const k of kids) n.append(k);
  return n;
};

async function render(error) {
  const st = await ask('status');
  app.replaceChildren();
  if (error) app.append(el('p', { className: 'err', textContent: error }));
  if (!st.paired) return renderPair();
  if (st.attached) return renderAttached(st);
  return renderSessions(st);
}

function renderPair() {
  const relay = el('input', { type: 'text', placeholder: 'relay.example.com:4997' });
  const code = el('input', { type: 'password', placeholder: 'XXXXX-XXXXX-…' });
  const go = el('button', { textContent: 'Pair' });
  go.onclick = async () => {
    go.disabled = true; go.textContent = 'Pairing…';
    const r = await ask('pair', { relayUrl: relay.value, backupCode: code.value });
    render(r?.error ? `Could not pair: ${r.error}` : undefined);
  };
  app.append(
    el('h1', { textContent: 'Pair this browser' }),
    el('p', { textContent: 'Your backup code is in the joy app under Settings → Account. It is kept in this browser profile and is the whole account: pair only a browser you trust.' }),
    el('label', {}, 'Relay', relay), el('label', {}, 'Backup code', code), go,
  );
}

async function renderSessions(st) {
  app.append(el('div', { className: 'row' }, el('h1', { textContent: 'Attach to a session' }), unpairButton()));
  app.append(el('p', { textContent: `Scripts the chosen session emits will run in this browser. ${st.relayUrl}` }));
  const announce = el('input', { type: 'checkbox', checked: true });
  app.append(el('label', { className: 'check' }, announce, 'Tell the session a browser attached'));
  const list = el('ul'); app.append(list);
  list.append(el('p', { textContent: 'Loading sessions…' }));
  const r = await ask('sessions');
  list.replaceChildren();
  if (r?.error) return list.append(el('p', { className: 'err', textContent: r.error }));
  if (!r.sessions.length) return list.append(el('p', { textContent: 'No sessions. Start one with: joy new <dir> --headless' }));
  for (const s of r.sessions) {
    const title = el('div', { className: 't', textContent: s.title ?? s.cwd?.split('/').pop() ?? s.localId });
    if (s.headless) title.append(el('span', { className: 'tag', textContent: 'headless' }));
    if (!s.readable) title.append(el('span', { className: 'tag', textContent: 'unreadable' }));
    const li = el('li', { className: s.online ? '' : 'off' }, title,
      el('div', { className: 's', textContent: `${s.localId} · ${s.harness} · ${s.host ?? '?'} · ${s.online ? 'online' : 'offline'}` }),
      el('div', { className: 's', textContent: s.cwd ?? '' }));
    li.onclick = async () => { const a = await ask('attach', { session: s, announce: announce.checked }); render(a?.error); };
    list.append(li);
  }
}

function renderAttached(st) {
  const a = st.attached;
  const detach = el('button', { className: 'quiet', textContent: 'Detach' });
  detach.onclick = async () => { await ask('detach'); render(); };
  app.append(
    el('div', { className: 'row' }, el('h1', { textContent: 'Attached' }), detach),
    el('div', {}, el('div', { className: 't ok', textContent: a.title ?? a.localId }), el('div', { className: 's', textContent: `${a.localId} · ${st.relayUrl}` })),
    el('p', { textContent: 'While a script runs, Chrome shows a bar saying this extension is debugging the browser. That is how an agent-written script is allowed to run at all.' }),
    el('pre', { textContent: st.log.slice(-14).join('\n') || 'Waiting for the session to emit <joy-browser-execute>…' }),
  );
}

function unpairButton() {
  const b = el('button', { className: 'quiet', textContent: 'Unpair' });
  b.onclick = async () => { await ask('unpair'); render(); };
  return b;
}

chrome.storage.onChanged.addListener((changes) => { if (changes.log || changes.attached) render(); });
render();
