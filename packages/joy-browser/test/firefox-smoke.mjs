#!/usr/bin/env node
// The same scenario as chrome-smoke.mjs, in a REAL Firefox, through geckodriver.
// Not part of `pnpm test`. Run it by hand:
//
//   node test/firefox-smoke.mjs /path/to/firefox /path/to/geckodriver
//
// What it proves that Chromium cannot: the Manifest V2 build loads, the module
// background PAGE runs, scripts go through tabs.executeScript (there is no
// debugger API here), and browser.* promises carry the popup and the panel.
// The page button sits in a closed shadow root that WebDriver cannot look
// into, so it is driven the way a person drives it: a click where the button
// is, then typing.
import { spawn, execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { EXT, sleep, until, step, cleanup, run, startWorld, helloAndScripts } from './smoke-lib.mjs';

const [FIREFOX, GECKO] = process.argv.slice(2);
if (!FIREFOX || !GECKO) { console.error('usage: node test/firefox-smoke.mjs /path/to/firefox /path/to/geckodriver'); process.exit(2); }
const ADDON_ID = JSON.parse(execFileSync(process.execPath, ['-e', `process.stdout.write(JSON.stringify(require(${JSON.stringify(join(EXT, 'manifest.firefox.json'))}).browser_specific_settings.gecko.id))`]).toString());
const UUID = '6a0f3c1e-5d2b-4e7a-9c11-0b5e2d7f4a90'; // pinned, so the popup's moz-extension:// address is known

async function main() {
  execFileSync(process.execPath, [join(EXT, 'build.mjs')], { stdio: 'ignore' });
  const w = await startWorld();
  const { pageUrl, relayUrl, backupCode, takePrompt, say, endTurn, agentTurn } = w;

  // ── Firefox, with dist/firefox installed as a temporary add-on ──
  const port = 20000 + Math.floor(Math.random() * 20000);
  const gecko = spawn(GECKO, ['--port', String(port), '--allow-system-access'], { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, MOZ_HEADLESS: '1' } });
  cleanup.push(() => gecko.kill('SIGKILL'));
  const base = `http://127.0.0.1:${port}`;
  await until('geckodriver', () => fetch(`${base}/status`).then((r) => r.ok, () => false));
  const wd = async (method, path, body) => {
    const r = await fetch(`${base}${path}`, { method, headers: { 'content-type': 'application/json' }, body: method === 'GET' ? undefined : JSON.stringify(body ?? {}) });
    const j = await r.json();
    if (!r.ok) throw new Error(`${method} ${path}: ${j.value?.message ?? r.status}`);
    return j.value;
  };
  const { sessionId: sid } = await wd('POST', '/session', { capabilities: { alwaysMatch: { 'moz:firefoxOptions': { binary: FIREFOX, args: ['-headless', '-width', '1100', '-height', '800'], prefs: { 'extensions.webextensions.uuids': JSON.stringify({ [ADDON_ID]: UUID }) } } } } });
  cleanup.push(() => wd('DELETE', `/session/${sid}`).catch(() => {}));
  const S = (method, path, body) => wd(method, `/session/${sid}${path}`, body);
  await S('POST', '/moz/addon/install', { path: join(EXT, 'dist/firefox'), temporary: true });
  const js = (script, ...args) => S('POST', '/execute/sync', { script, args });
  step(`Firefox up, ${ADDON_ID} installed from dist/firefox (Manifest V2)`);

  // ── setup in the popup ──
  // WebDriver may not navigate to a moz-extension:// page itself; the browser's
  // own (privileged) context opens it as a tab, the way the toolbar would.
  const before = await S('GET', '/window/handles');
  await S('POST', '/moz/context', { context: 'chrome' });
  await js(`const w = Services.wm.getMostRecentWindow('navigator:browser'); w.gBrowser.selectedTab = w.gBrowser.addTab(arguments[0], { triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal() });`, `moz-extension://${UUID}/popup.html`);
  await S('POST', '/moz/context', { context: 'content' });
  const popupWin = await until('the popup tab', async () => (await S('GET', '/window/handles')).find((h) => !before.includes(h)));
  await S('POST', '/window', { handle: popupWin });
  const popupText = () => js('return document.body.innerText');
  const press = (label) => js(`const b = [...document.querySelectorAll('button')].find((n) => n.textContent.includes(arguments[0])); if (!b) throw new Error('no button: ' + arguments[0] + ' in: ' + document.body.innerText); b.click();`, label);
  await until('the pairing form', () => js(`return !!document.querySelector('input[type=password]')`));
  await js(`const [relay, code] = document.querySelectorAll('input'); relay.value = arguments[0]; code.value = arguments[1];`, relayUrl, backupCode);
  await press('Continue');
  await until('the machine step', () => js(`return [...document.querySelectorAll('option')].some((o) => o.textContent === 'smoke-box' && !o.disabled)`)).catch(async (e) => { throw new Error(`${e.message} — popup shows: ${await popupText()}`); });
  step('paired from the backup code; the machine is offered by its sealed name, online');
  await press('Start my session');
  await w.acceptSpawn();
  await helloAndScripts(w); // ← tabs.executeScript, in a tab the extension opened itself
  await until('the popup to show the linked session', async () => (await popupText()).includes('c0ffee42'));

  // ── the page button: click where it is, type, and the session hears a person ──
  const pageWin = (await S('POST', '/window/new', { type: 'tab' })).handle;
  await S('POST', '/window', { handle: pageWin });
  await S('POST', '/url', { url: pageUrl });
  await until('the page button', () => js(`return !!document.querySelector('joy-browser-root')`));
  if (await js(`const h = document.querySelector('joy-browser-root'); return h.shadowRoot !== null || h.childNodes.length > 0`)) throw new Error('the page can see into the widget');
  const [vw, vh] = await js('return [innerWidth, innerHeight]');
  const clickAt = (x, y) => S('POST', '/actions', { actions: [{ type: 'pointer', id: 'mouse', parameters: { pointerType: 'mouse' }, actions: [{ type: 'pointerMove', x: Math.round(x), y: Math.round(y), duration: 0 }, { type: 'pointerDown', button: 0 }, { type: 'pointerUp', button: 0 }] }] });
  const typeKeys = (text) => S('POST', '/actions', { actions: [{ type: 'key', id: 'keys', actions: [...text, ''].flatMap((value) => [{ type: 'keyDown', value }, { type: 'keyUp', value }]) }] });
  await clickAt(vw - 12 - 23, vh - 12 - 23); // the button's resting place: bottom right
  await sleep(400); // the panel opens and focuses its box
  await typeKeys('What does the Pro plan cost?');
  const asked = await takePrompt('the chat message');
  if (asked.text !== 'What does the Pro plan cost?') throw new Error(`the chat message arrived as: ${JSON.stringify(asked.text)}`);
  step('page button → panel: a click and real typing reached the session as the user');

  // ── a remembered script: OFF until approved (here, from the popup's Saved scripts page) ──
  const saved = await agentTurn(asked.turnId, `It is $49. I will keep a change for you.\n\n<joy-browser-remember name="Free pricing" match="127.0.0.1">\ndocument.querySelector('.price').textContent = 'FREE';\n</joy-browser-remember>`, 'the remember result');
  if (!/saved "Free pricing" for 127\.0\.0\.1/.test(saved.text) || !/OFF until the user approves/.test(saved.text)) throw new Error(`unexpected remember result:\n${saved.text}`);
  await say(saved.turnId, 'Saved. Approve it to switch it on.'); await endTurn(saved.turnId);
  await S('POST', '/refresh'); await sleep(1500);
  if (await js(`return document.querySelector('.price').textContent`) !== '$49 / month') throw new Error('an UNAPPROVED script ran');
  await S('POST', '/window', { handle: popupWin });
  await S('POST', '/refresh');
  await until('the waiting script to be flagged', async () => (await popupText()).includes('1 waiting for you'));
  await press('Saved scripts');
  // Not "the text Free pricing": the main page's log has that too, before the scripts page has drawn.
  await until('the scripts page', () => js(`return document.querySelector('h1')?.textContent === 'Saved scripts' && [...document.querySelectorAll('button')].some((b) => b.textContent === 'Approve')`));
  await press('Approve');
  await until('the script to be on', () => js(`return [...document.querySelectorAll('button')].some((b) => b.textContent === 'On')`));
  await S('POST', '/window', { handle: pageWin });
  await S('POST', '/refresh');
  await until('the saved script to run on the next visit', () => js(`return document.querySelector('.price')?.textContent === 'FREE'`));
  step('remembered script: did NOT run while unapproved; approved in Settings; ran by itself on the next visit');

  // ── the brakes ──
  await S('POST', '/window', { handle: popupWin });
  await press('Back'); await until('the main page', async () => (await popupText()).includes('Excluded sites'));
  await press('Excluded sites'); await until('the excluded-sites page', () => js(`return !!document.querySelector('input[type=text]')`));
  await js(`document.querySelector('input[type=text]').value = '127.0.0.1'`);
  await press('Add');
  await until('the site in the list', () => js(`return [...document.querySelectorAll('li code')].some((n) => n.textContent === '127.0.0.1')`));
  await S('POST', '/window', { handle: pageWin });
  await until('the page button to leave the excluded site', () => js(`return !document.querySelector('joy-browser-root')`));
  await S('POST', '/refresh'); await sleep(1500);
  if (await js(`return document.querySelector('.price').textContent`) !== '$49 / month') throw new Error('a saved script ran on an excluded site');
  await w.sendAsAccount('Read the price again.');
  const again = await takePrompt('the next prompt');
  const refused = await agentTurn(again.turnId, `<joy-browser-execute url="${pageUrl}">\nreturn document.title;\n</joy-browser-execute>`, 'the refusal');
  if (!/status: error/.test(refused.text) || !/excluded-sites list/.test(refused.text)) throw new Error(`expected an excluded-site refusal, got:\n${refused.text}`);
  const listed = await agentTurn(refused.turnId, '<joy-browser-execute tab="list"></joy-browser-execute>', 'the tab list');
  if (listed.text.includes('127.0.0.1')) throw new Error(`an excluded tab was reported:\n${listed.text}`);
  step('excluded site: button gone, saved script silent, the agent is refused and the tab is not listed');
  await S('POST', '/window', { handle: popupWin });
  await press('Back'); await until('the main page', async () => (await popupText()).includes('Pause'));
  await press('Pause');
  const paused = await agentTurn(listed.turnId, '<joy-browser-execute>\nreturn 1;\n</joy-browser-execute>', 'the paused refusal');
  if (!/status: error/.test(paused.text) || !/paused browser control/.test(paused.text)) throw new Error(`expected a paused refusal, got:\n${paused.text}`);
  step('paused: nothing runs, and the agent is told why');
  await endTurn(paused.turnId);
}

await run('joy-browser smoke test — Firefox', main);
