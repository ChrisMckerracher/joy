// The loop that turns an agent's tag into a run and an answer.
// Everything chrome-specific is injected (`execute`, `store`), so this runs
// under `node --test` against a scripted relay.
//
// Three rules carry the safety of the whole extension:
//
//  1. ONLY THE AGENT'S OWN TEXT RUNS. A tag is honoured in a daemon-written
//     record whose role is not `user` and whose event is non-thinking text.
//     Prompts (`turn.queued`), mirrored user records and legacy plain payloads
//     never run — otherwise a page could print a tag into a result, the result
//     would be queued as a prompt, and the extension would execute its own
//     echo in a loop.
//  2. HISTORY IS NOT NEWS. Attaching starts at the session's head: a tag from
//     an hour ago must not fire because a browser just connected.
//  3. AT MOST ONCE. The cursor is saved BEFORE a script runs. A service worker
//     can die at any moment; re-running a script (a click, a form submit) on
//     restart is worse than the agent having to ask again.
import { openPayload, sealText } from './crypto.js';
import { extractExecuteTags, describeResult, browserMessage } from './tags.js';

/** The agent's visible text in one relay event, or null. */
export function agentTextOf(event, key) {
  if (!event?.content || event.kind === 'turn.queued') return null;
  const p = openPayload(event.content.ciphertext, key);
  if (!p || p.t !== 'record' || p.record.role === 'user') return null;
  const ev = p.record.content?.data?.ev;
  return ev && ev.t === 'text' && typeof ev.text === 'string' && !ev.thinking ? ev.text : null;
}

export class Watcher {
  /** @param {{ relay: any, store: { load(): Promise<any>, saveCursor(n: number): Promise<void> }, execute: (tag: any) => Promise<any>, log?: (line: string) => void }} deps */
  constructor({ relay, store, execute, log = () => {} }) {
    this.relay = relay; this.store = store; this.execute = execute; this.log = log;
    this.running = null; this.again = false;
  }

  /** Pokes and alarms overlap; polls must not. A request that arrives while a
   *  poll runs asks for exactly one more after it. */
  poll() {
    if (this.running) { this.again = true; return this.running; }
    this.running = (async () => {
      try { do { this.again = false; await this.#once(); } while (this.again); }
      finally { this.running = null; }
    })();
    return this.running;
  }

  async #once() {
    const state = await this.store.load();
    if (!state?.sessionId) return;
    const { sessionId, key } = state;
    let cursor = Number(state.cursor) || 0;
    for (;;) {
      const page = await this.relay.events(sessionId, cursor, 200);
      const events = page?.messages ?? [];
      if (!events.length) return;
      for (const e of events) {
        const seq = Number(e.seq);
        if (!(seq > cursor)) continue;
        cursor = seq;
        await this.store.saveCursor(cursor); // rule 3: before anything runs
        const tags = extractExecuteTags(agentTextOf(e, key) ?? '');
        if (!tags.length) continue;
        const results = [];
        for (const tag of tags) {
          this.log(`running ${tag.attrs.url ? `on ${tag.attrs.url}` : tag.attrs.tab ? `in tab ${tag.attrs.tab}` : 'in the active tab'} (${tag.code.length} chars)`);
          try { results.push(await this.execute(tag)); }
          catch (err) { results.push({ tab: null, error: err?.message ?? String(err) }); }
        }
        const body = results.map((r, i) => describeResult(r, i, results.length)).join('\n\n');
        await this.relay.sendCiphertext(sessionId, sealText(browserMessage(body), key));
        this.log(`answered with ${results.length} result${results.length === 1 ? '' : 's'}${results.some((r) => r.error) ? ' (with errors)' : ''}`);
      }
    }
  }
}
