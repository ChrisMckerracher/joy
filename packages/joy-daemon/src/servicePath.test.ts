import { test, expect } from "vitest";
import { serviceEnvPath, hasTransientEntries } from "./servicePath";

const NODE_DIR = "/home/u/.local/share/fnm/node-versions/v24.13.0/installation/bin";
const ALIAS = "/home/u/.local/share/fnm/aliases/default/bin";

test("the service's own node comes first", () => {
    const out = serviceEnvPath("/usr/bin:/bin", { nodeDir: NODE_DIR });
    expect(out.split(":")[0]).toBe(NODE_DIR);
    expect(out).toBe(`${NODE_DIR}:/usr/bin:/bin`);
});

test("per-shell fnm directories are dropped on both platforms", () => {
    const raw = [
        "/usr/bin",
        "/run/user/1000/fnm_multishells/3841553_1787749880581/bin",
        "/home/u/.local/state/fnm_multishells/46153_1789575440678/bin",
        "/bin",
    ].join(":");
    const out = serviceEnvPath(raw, { nodeDir: NODE_DIR });
    expect(out).toBe(`${NODE_DIR}:/usr/bin:/bin`);
    expect(out).not.toContain("fnm_multishells");
});

test("the stable alias sits behind the node dir when the machine has one", () => {
    const out = serviceEnvPath("/usr/bin", { nodeDir: NODE_DIR, aliasDir: ALIAS });
    expect(out).toBe(`${NODE_DIR}:${ALIAS}:/usr/bin`);
});

test("no alias dir means no alias entry", () => {
    expect(serviceEnvPath("/usr/bin", { nodeDir: NODE_DIR, aliasDir: null }))
        .toBe(`${NODE_DIR}:/usr/bin`);
});

test("duplicates collapse, keeping first position", () => {
    const out = serviceEnvPath("/usr/bin:/bin:/usr/bin:/bin", { nodeDir: NODE_DIR });
    expect(out).toBe(`${NODE_DIR}:/usr/bin:/bin`);
});

test("a node dir already in the PATH is promoted, not repeated", () => {
    const out = serviceEnvPath(`/usr/bin:${NODE_DIR}:/bin`, { nodeDir: NODE_DIR });
    expect(out).toBe(`${NODE_DIR}:/usr/bin:/bin`);
    expect(out.split(":").filter((d) => d === NODE_DIR)).toHaveLength(1);
});

test("order is otherwise preserved — the precedence in a PATH is deliberate", () => {
    const out = serviceEnvPath("/a:/b:/c", { nodeDir: NODE_DIR });
    expect(out.split(":").slice(1)).toEqual(["/a", "/b", "/c"]);
});

test("entries that do not exist are kept: they may be created later", () => {
    const out = serviceEnvPath("/does/not/exist/bin:/usr/bin", { nodeDir: NODE_DIR });
    expect(out).toContain("/does/not/exist/bin");
});

test("an empty PATH still yields a usable one", () => {
    expect(serviceEnvPath("", { nodeDir: NODE_DIR })).toBe(NODE_DIR);
});

test("empty segments are ignored", () => {
    expect(serviceEnvPath("/usr/bin::/bin:", { nodeDir: NODE_DIR }))
        .toBe(`${NODE_DIR}:/usr/bin:/bin`);
});

test("hasTransientEntries reports what the fix removes", () => {
    expect(hasTransientEntries("/usr/bin:/run/user/1000/fnm_multishells/1_2/bin")).toBe(true);
    expect(hasTransientEntries("/usr/bin:/bin")).toBe(false);
    expect(hasTransientEntries("")).toBe(false);
});
