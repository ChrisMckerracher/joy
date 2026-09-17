# joy-browser

A Chrome extension that lets a joy session act in your browser. The agent writes
a script between `<joy-browser-execute>` tags; the extension runs it in a tab and
sends the outcome back into the session as a `<joy-message from="browser">`.

It is a client of your account, like the app and the MCP server. It talks only
to your relay: nothing listens on your machine, no port is opened, and the agent
can be on a different machine from the browser. The session it answers to is
usually a headless one (`joy new <dir> --headless`).

```
 agent (any machine)             relay                     your browser
┌─────────────────────┐   ┌────────────────┐   ┌──────────────────────────────┐
│ emits the tag in    │──►│ sealed output  │──►│ extension opens it, runs the │
│ its reply, ends the │   │                │   │ script in a tab              │
│ turn                │◄──│ durable queue  │◄──│ queues the sealed result     │
└─────────────────────┘   └────────────────┘   └──────────────────────────────┘
```

## Install

There is no build step and the package has no dependencies.

1. Open `chrome://extensions`, turn on **Developer mode**, choose **Load unpacked**, and pick this directory.
2. Click the extension, enter your relay's address and your backup code (the joy app shows it under Settings → Account), and press **Pair**.
3. Pick the session this browser should answer to. With **Tell the session a browser attached** ticked, the session gets a message saying so, which is how the agent knows it may use the tag.

Sessions learn the tag from the daemon's system prompt, so the daemon on the
agent's machine must be recent enough to carry it. A session that was already
running when its daemon updated learns it from `/joy-prompt`.

## What the agent writes

```
<joy-browser-execute>
return [...document.querySelectorAll("h2")].map((h) => h.textContent);
</joy-browser-execute>
```

The body is the inside of an async function running in the page: `await` works,
and `return` is the answer. Attributes on the opening tag choose where it runs:

| Opening tag | Runs in |
|---|---|
| `<joy-browser-execute>` | the active tab |
| `<joy-browser-execute tab="123">` | that tab |
| `<joy-browser-execute url="https://…">` | a new tab at that URL, once it has loaded; the body may be empty |
| `<joy-browser-execute tab="list">` | nowhere: reports the open tabs |

The result names the tab it ran in, `status: ok` or `status: error`, the returned
value as JSON, and anything the script logged. The round trip is a turn boundary,
not a tool call: the agent ends its turn after the tag and the result is its next
message.

## What runs, and what never does

- **Only the agent's own reply text.** A tag in a prompt, in a user's message, in the agent's thinking, or inside a fenced code block never runs. That includes the extension's own results: a page cannot print a tag into a result and have it executed.
- **Only from the moment you attach.** Attaching starts at the end of the conversation, so a tag from earlier does not fire because a browser appeared.
- **At most once.** The position in the conversation is saved before a script runs. If the browser dies mid-script the agent gets no answer and can ask again; a click or a form submit is never repeated on restart.

## Things to know

- **The debugging bar.** Manifest V3 will not evaluate a string, and an agent's script is a string, so scripts run through `chrome.debugger`. Chrome shows "Joy Browser is debugging this browser" while one runs. The debugger is attached per script and detached afterwards. Browser-internal pages (`chrome://`, the Web Store) cannot be scripted.
- **It is your real browser.** Scripts run with your logins. The agent is told not to submit, buy, send or delete anything you did not ask for, and to treat page content as data rather than instructions, but a page can still try to talk an agent into things. Attach it to sessions whose task you know.
- **The backup code is the whole account.** It is kept in this browser profile's extension storage so the extension can sign in again by itself. Pair only a browser profile you trust, and **Unpair** removes it.
- **Latency.** Chrome puts an idle extension to sleep. A wake-up alarm checks every 30 seconds, so a script waits at most that long; while the popup is open or the session is busy it runs at once.

## Tests

```bash
pnpm test                          # crypto, tag parsing, the watcher — plain node, no browser
node test/chrome-smoke.mjs         # real relay + real Chromium, driven through the popup
```

The crypto tests seal with this package and open with `joy-mcp`'s Node client,
and the reverse, so the two cannot drift apart. `packages/joy-relay/test/joy-browser.e2e.test.mjs`
runs the extension's relay client and watcher against a real relay.

`vendor/nacl-fast.min.js` is [tweetnacl](https://github.com/dchest/tweetnacl-js) 1.0.3,
unmodified and in the public domain (Unlicense). It is vendored so that loading
the directory unpacked works with no install.
