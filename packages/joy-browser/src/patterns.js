// Excluded sites: the patterns a person types, and whether a URL falls under one.
// Pure — shared by the script runner, the tab list, saved scripts and the page button.
//
//   example.com              the site and every subdomain, any path
//   *.example.com            the same (a leading *. is how people write it)
//   example.com/account/*    one part of a site; * is "anything"
//   localhost:3000           a port narrows it; without one, any port matches
//
// Only http(s) pages can match. Anything that does not parse matches nothing —
// a typo must never silently exclude (or, worse, appear to exclude) a site.

export function parsePattern(input) {
  let s = String(input ?? '').trim().toLowerCase();
  if (!s) return null;
  s = s.replace(/^[a-z][a-z0-9+.-]*:\/\//, '');      // a pasted URL: drop the scheme
  const slash = s.indexOf('/');
  let host = slash < 0 ? s : s.slice(0, slash);
  let path = slash < 0 ? '' : s.slice(slash);
  host = host.replace(/^\*\./, '').replace(/^\.+|\.+$/g, '');
  let port = null;
  const m = /^(.*):(\d{1,5})$/.exec(host);
  if (m) { host = m[1]; port = m[2]; }
  if (!host || /[^a-z0-9.\-*]/.test(host) || host.includes('*')) return null;
  if (path === '/' || path === '/*') path = '';
  return { host, port, path };
}

/** The pattern as it is stored and shown: parsed, then written back plainly. */
export function normalizePattern(input) {
  const p = parsePattern(input);
  return p ? `${p.host}${p.port ? `:${p.port}` : ''}${p.path}` : null;
}

const globToRegExp = (glob) => new RegExp(`^${glob.split('*').map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`);

export function matchesPattern(url, pattern) {
  const p = typeof pattern === 'string' ? parsePattern(pattern) : pattern;
  if (!p) return false;
  let u;
  try { u = new URL(url); } catch { return false; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
  const host = u.hostname.toLowerCase();
  if (host !== p.host && !host.endsWith(`.${p.host}`)) return false;
  if (p.port && (u.port || (u.protocol === 'https:' ? '443' : '80')) !== p.port) return false;
  if (!p.path) return true;
  const glob = p.path.endsWith('*') ? p.path : `${p.path}*`; // "/account" covers what is under it
  return globToRegExp(glob).test(u.pathname + u.search);
}

export const matchesAny = (url, patterns) => (patterns ?? []).some((p) => matchesPattern(url, p));
