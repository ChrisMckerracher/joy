import { test } from 'node:test';
import assert from 'node:assert/strict';
import { matchesPattern, matchesAny, normalizePattern, parsePattern } from '../src/patterns.js';

test('a bare site covers itself, its subdomains and every path', () => {
  for (const url of ['https://bank.com/', 'https://www.bank.com/login?x=1', 'http://a.b.bank.com/deep/path']) assert.equal(matchesPattern(url, 'bank.com'), true, url);
  for (const url of ['https://notbank.com/', 'https://bank.com.evil.test/', 'https://evil.test/bank.com']) assert.equal(matchesPattern(url, 'bank.com'), false, url);
});

test('*.site is how people write it, and means the same', () => {
  assert.equal(matchesPattern('https://bank.com/', '*.bank.com'), true);
  assert.equal(matchesPattern('https://my.bank.com/', '*.bank.com'), true);
});

test('a path narrows it to one part of a site', () => {
  assert.equal(matchesPattern('https://example.com/account/cards', 'example.com/account/*'), true);
  assert.equal(matchesPattern('https://example.com/account', 'example.com/account'), true);
  assert.equal(matchesPattern('https://example.com/account/x', 'example.com/account'), true, 'no star still covers what is under it');
  assert.equal(matchesPattern('https://example.com/blog', 'example.com/account/*'), false);
  assert.equal(matchesPattern('https://example.com/a/1/edit', 'example.com/a/*/edit'), true);
});

test('a pasted URL works; case and a trailing slash do not matter', () => {
  assert.equal(normalizePattern('https://WWW.Example.com/'), 'www.example.com');
  assert.equal(matchesPattern('https://www.example.com/x', 'HTTPS://www.example.com/'), true);
});

test('a port narrows it; without one any port matches', () => {
  assert.equal(matchesPattern('http://localhost:3000/', 'localhost:3000'), true);
  assert.equal(matchesPattern('http://localhost:4000/', 'localhost:3000'), false);
  assert.equal(matchesPattern('http://localhost:4000/', 'localhost'), true);
  assert.equal(matchesPattern('https://secure.test/', 'secure.test:443'), true);
});

test('only web pages match, and a typo matches nothing', () => {
  assert.equal(matchesPattern('chrome://settings/', 'settings'), false);
  assert.equal(matchesPattern('file:///etc/passwd', 'etc'), false);
  for (const bad of ['', '   ', 'ex ample.com', 'exa*mple.com', '*', 'http://']) { assert.equal(parsePattern(bad), null, JSON.stringify(bad)); assert.equal(matchesPattern('https://example.com/', bad), false); }
  assert.equal(matchesPattern('not a url', 'example.com'), false);
});

test('matchesAny over a list, including an empty or missing one', () => {
  assert.equal(matchesAny('https://a.test/', ['b.test', 'a.test']), true);
  assert.equal(matchesAny('https://a.test/', []), false);
  assert.equal(matchesAny('https://a.test/', undefined), false);
});

test('case-sensitive paths and trailing-dot hosts cannot evade an exclusion', () => {
  assert.equal(normalizePattern('HTTPS://Example.COM/Account/*'), 'example.com/Account/*');
  assert.equal(matchesPattern('https://example.com/Account/cards', 'Example.com/Account/*'), true);
  assert.equal(matchesPattern('https://example.com/account/cards', 'Example.com/Account/*'), false);
  assert.equal(matchesPattern('https://example.com./Account/cards', 'example.com'), true);
});

test('invalid ports are rejected and padded ports are canonicalized', () => {
  assert.equal(normalizePattern('localhost:65536'), null);
  assert.equal(normalizePattern('localhost:0'), null);
  assert.equal(matchesPattern('http://localhost:3000', 'localhost:03000'), true);
});
