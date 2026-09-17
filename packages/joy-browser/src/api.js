// One name for the extension API in both browsers. Firefox's promise-returning
// namespace is `browser`; its `chrome` alias is callback-only under Manifest
// V2, which is what the Firefox build uses. Chrome has no `browser` and its
// `chrome` returns promises under Manifest V3.
export const api = globalThis.browser ?? globalThis.chrome;
