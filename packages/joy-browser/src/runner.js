// Running an agent-written script in a tab. Two browsers, two doors:
//
//  Chrome   chrome.debugger → Runtime.evaluate. Manifest V3 will not evaluate
//           a string through chrome.scripting, and an agent's script is a
//           string. Runs in the page's own world; the console is captured over
//           the protocol. Cost: the "is debugging this browser" bar, for as
//           long as a script runs.
//  Firefox  tabs.executeScript({ code }) — Manifest V2, which Firefox keeps.
//           Runs as a content script: the DOM is all there, the page's own
//           JavaScript variables are not. The console is captured by wrapping
//           it inside the injected code.
//
// Both return { tab, value | error, console }, value already JSON text.
import { api } from './api.js';

const RUN_TIMEOUT_MS = 60_000;
export const tabInfo = (t) => ({ id: t.id, url: t.url, title: t.title });
export async function withTimeout(p, ms, what) {
  let timer;
  try { return await Promise.race([p, new Promise((_, rej) => { timer = setTimeout(() => rej(new Error(`${what} timed out after ${ms / 1000}s`)), ms); })]); }
  finally { clearTimeout(timer); }
}

const remoteText = (a) => (a.value !== undefined ? (typeof a.value === 'string' ? a.value : JSON.stringify(a.value)) : a.description ?? a.type);

async function runWithDebugger(tab, code) {
  const target = { tabId: tab.id };
  const lines = [];
  const onEvent = (src, method, params) => {
    if (src.tabId === tab.id && method === 'Runtime.consoleAPICalled' && lines.length < 100) lines.push(`${params.type}: ${(params.args ?? []).map(remoteText).join(' ')}`.slice(0, 4000));
  };
  let attaching;
  try { attaching = api.debugger.attach(target, '1.3'); await withTimeout(attaching, 10_000, 'debugger attach'); }
  catch (e) {
    // The API cannot be cancelled. If it attaches after our deadline, release
    // it then rather than leaving the tab held by an abandoned run.
    void attaching?.then(() => withTimeout(api.debugger.detach(target), 5000, 'debugger detach')).catch(() => {});
    return { tab: tabInfo(tab), error: `cannot attach to this tab (${e.message}). Browser-internal pages and tabs another debugger holds cannot be scripted.` }; }
  api.debugger.onEvent.addListener(onEvent);
  try {
    await withTimeout(api.debugger.sendCommand(target, 'Runtime.enable'), 10_000, 'debugger enable');
    // An async function body: `await` works and `return` is the answer.
    const r = await withTimeout(api.debugger.sendCommand(target, 'Runtime.evaluate', {
      expression: `(async () => {\n${code}\n})()`, awaitPromise: true, returnByValue: true, userGesture: true,
    }), RUN_TIMEOUT_MS, 'the script');
    const now = await api.tabs.get(tab.id).catch(() => tab);
    if (r.exceptionDetails) return { tab: tabInfo(now), error: r.exceptionDetails.exception?.description ?? r.exceptionDetails.text ?? 'script threw', console: lines };
    const value = r.result?.type === 'undefined' ? undefined : typeof r.result?.value === 'string' ? r.result.value : JSON.stringify(r.result?.value ?? null, null, 2);
    return { tab: tabInfo(now), value, console: lines };
  } catch (e) {
    const now = await api.tabs.get(tab.id).catch(() => tab);
    // A script that navigates dies with its page; that is an outcome, not a fault.
    const navigated = /navigated|context was destroyed|Target closed|Cannot find context/i.test(e.message ?? '');
    return { tab: tabInfo(now), error: navigated ? `the page unloaded while the script ran (now at ${now.url}). Run another script to read the new page.` : e.message ?? String(e), console: lines };
  } finally {
    api.debugger.onEvent.removeListener(onEvent);
    await withTimeout(api.debugger.detach(target), 5000, 'debugger detach').catch(() => {});
  }
}

/** The injected wrapper: capture console.*, run the body as an async
 *  function, and hand back JSON text — a structured clone of an arbitrary
 *  return value can fail, a string cannot. */
export const contentScriptSource = (code) => `(() => {
  const lines = []; const orig = {}; let timer;
  const show = (a) => { if (typeof a === 'string') return a; try { return JSON.stringify(a); } catch { return String(a); } };
  for (const k of ['log', 'info', 'warn', 'error', 'debug']) { orig[k] = console[k]; console[k] = (...a) => { if (lines.length < 100) lines.push((k + ': ' + a.map(show).join(' ')).slice(0, 4000)); orig[k].apply(console, a); }; }
  const done = () => { clearTimeout(timer); for (const k in orig) console[k] = orig[k]; };
  const text = (v) => { if (v === undefined) return undefined; if (typeof v === 'string') return v; try { return JSON.stringify(v, null, 2); } catch { return String(v); } };
  const work = (async () => {\n${code}\n})();
  const limit = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('the script timed out after 60s')), ${RUN_TIMEOUT_MS}); });
  return Promise.race([work, limit]).then(
    (v) => { done(); return { ok: true, value: text(v), console: lines }; },
    (e) => { done(); return { ok: false, error: String(e), console: lines }; }); // String(): Firefox keeps the message OUT of e.stack
})()`;

async function runAsContentScript(tab, code) {
  try {
    const [r] = await withTimeout(api.tabs.executeScript(tab.id, { code: contentScriptSource(code), runAt: 'document_idle' }), RUN_TIMEOUT_MS + 5000, 'the script');
    const now = await api.tabs.get(tab.id).catch(() => tab);
    if (!r) return { tab: tabInfo(now), error: 'the page unloaded while the script ran. Run another script to read the new page.' };
    return r.ok ? { tab: tabInfo(now), value: r.value, console: r.console } : { tab: tabInfo(now), error: r.error, console: r.console };
  } catch (e) {
    return { tab: tabInfo(tab), error: /Missing host permission|cannot access/i.test(e.message ?? '') ? `this page cannot be scripted (${e.message})` : e.message ?? String(e) };
  }
}

export const runInTab = (tab, code) => (api.debugger ? runWithDebugger(tab, code) : runAsContentScript(tab, code));
