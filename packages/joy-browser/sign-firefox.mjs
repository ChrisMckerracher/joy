#!/usr/bin/env node
// Get Mozilla's signature on the Firefox build, UNLISTED: signed so that a
// normal Firefox will install and keep it, but never shown on
// addons.mozilla.org. Release Firefox refuses an unsigned extension outright,
// so this is the only way to install it for good.
//
//   WEB_EXT_API_KEY=user:123:45 WEB_EXT_API_SECRET=… node sign-firefox.mjs
//
// The two values are the "JWT issuer" and "JWT secret" from
// https://addons.mozilla.org/developers/addon/api/key/ (any Firefox account).
// The result lands in dist/signed/ as an .xpi: open it in Firefox to install.
//
// Two things Mozilla insists on. The add-on id (manifest.firefox.json →
// browser_specific_settings.gecko.id) belongs to whichever account signs it
// first — signing under your own account means choosing your own id. And a
// version can be signed once: bump "version" in BOTH manifests to sign again.
import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));
const missing = ['WEB_EXT_API_KEY', 'WEB_EXT_API_SECRET'].filter((k) => !process.env[k]);
if (missing.length) { console.error(`${missing.join(' and ')} not set.\nCreate them at https://addons.mozilla.org/developers/addon/api/key/ — the JWT issuer is the key, the JWT secret is the secret.`); process.exit(2); }

execFileSync(process.execPath, [join(root, 'build.mjs')], { stdio: 'inherit' });
const { version, browser_specific_settings: { gecko } } = JSON.parse(readFileSync(join(root, 'manifest.firefox.json'), 'utf8'));
console.log(`signing ${gecko.id} ${version} (unlisted) — Mozilla's automated review usually takes a minute or two`);
// web-ext reads the two credentials from the environment itself, so they never appear in a process list.
const r = spawnSync('npx', ['--yes', 'web-ext@8', 'sign', '--channel', 'unlisted', '--source-dir', join(root, 'dist/firefox'), '--artifacts-dir', join(root, 'dist/signed')], { stdio: 'inherit' });
process.exit(r.status ?? 1);
