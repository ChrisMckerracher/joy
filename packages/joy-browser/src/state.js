// Short storage transactions must serialize; network work must never hold them.
export function serial() {
  let tail = Promise.resolve();
  return (fn) => { const p = tail.then(fn); tail = p.catch(() => {}); return p; };
}

export function sameLink(a, b) {
  return !!a && !!b && a.sessionId === b.sessionId && a.token === b.token;
}

// Bound caller waits without changing the opaque account/auth client. Durable
// intent ids make an uncertain spawn/result response safe to retry.
export function boundedRelay(relay, timeout) {
  return new Proxy(relay, { get(target, name) {
    const v = target[name];
    if (typeof v !== 'function') return v;
    if (name === 'stream') return v.bind(target);
    return (...args) => timeout(Promise.resolve().then(() => v.apply(target, args)), 20_000, `relay ${String(name)}`);
  } });
}
