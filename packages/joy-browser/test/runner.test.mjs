import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('../src/runner.js', import.meta.url), 'utf8').replace(/^import .*;$/gm, '').replace(/^export /gm, '');
function rig() {
  const timers = new Map(); let next = 0; const listeners = new Set(); let detached = 0;
  const api = { debugger: {
    attach: async () => {}, detach: async () => { detached++; }, sendCommand: async () => ({}),
    onEvent: { addListener: (f) => listeners.add(f), removeListener: (f) => listeners.delete(f) },
  }, tabs: { get: async (id) => ({ id }) } };
  const context = vm.createContext({ api, setTimeout: (fn, ms) => { const id = ++next; timers.set(id, { fn, ms }); return id; }, clearTimeout: (id) => timers.delete(id) });
  vm.runInContext(source + '\nglobalThis.h = { withTimeout, runInTab, contentScriptSource };', context);
  return { ...context.h, api, timers, listeners, detached: () => detached };
}
const flush = () => new Promise((r) => setImmediate(r));

test('resolved and rejected operations do not leave timeout timers alive', async () => {
  const r = rig(); assert.equal(await r.withTimeout(Promise.resolve('ok'), 100, 'job'), 'ok');
  await assert.rejects(r.withTimeout(Promise.reject(Error('failed')), 100, 'job'), /failed/);
  assert.equal(r.timers.size, 0);
});

test('a timed-out operation releases its timer and reports which operation stalled', async () => {
  const r = rig(); const result = assert.rejects(r.withTimeout(new Promise(() => {}), 100, 'job'), /job timed out/);
  [...r.timers.values()][0].fn(); await result; assert.equal(r.timers.size, 0);
});

test('debugger enable failure detaches and removes its console listener', async () => {
  const r = rig(); r.api.debugger.sendCommand = async () => { throw Error('closed tab'); };
  assert.match((await r.runInTab({ id: 1 }, 'return 1')).error, /closed tab/);
  assert.equal(r.detached(), 1); assert.equal(r.listeners.size, 0); assert.equal(r.timers.size, 0);
});

test('a debugger attach that completes after timeout is still detached', async () => {
  const r = rig(); let finish;
  r.api.debugger.attach = () => new Promise((resolve) => { finish = resolve; });
  const running = r.runInTab({ id: 1 }, 'return 1');
  [...r.timers.values()].find((x) => x.ms === 10000).fn();
  assert.match((await running).error, /attach.*timed out/);
  finish(); await flush(); assert.equal(r.detached(), 1);
});

test('a never-ending Firefox script releases its console wrappers on timeout', async () => {
  const r = rig(); const timers = new Map(); let next = 0;
  const original = () => {}; const console = Object.fromEntries(['log', 'info', 'warn', 'error', 'debug'].map((k) => [k, original]));
  const context = vm.createContext({ console, setTimeout: (fn, ms) => { const id = ++next; timers.set(id, { fn, ms }); return id; }, clearTimeout: (id) => timers.delete(id) });
  const result = vm.runInContext(r.contentScriptSource('await new Promise(() => {});'), context);
  assert.notEqual(console.log, original);
  const timeout = [...timers.values()].find((t) => t.ms === 60000);
  assert.ok(timeout, 'the injected wrapper owns its own timeout'); timeout.fn();
  assert.match((await result).error, /timed out/); assert.equal(console.log, original); assert.equal(timers.size, 0);
});
