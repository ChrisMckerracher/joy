# Your browser

An agent can act in your own browser: read a page you are logged in to, fill a form, click through a flow. The Joy Browser extension makes that possible. The agent writes a short script, the extension runs it in a tab, and the result goes back to the agent as its next message.

The agent does not need to be on the same machine as the browser. The extension is a client of your account and talks only to your relay, exactly as the app does, so nothing on your computer is opened to the network.

## Set it up

1. Get the extension from `packages/joy-browser` in the joy repository. In Chrome, open `chrome://extensions`, turn on **Developer mode**, choose **Load unpacked**, and pick that folder.
2. Click the extension. Enter your relay's address and your backup code, then press **Pair**. Your backup code is in the app under Settings → Account.
3. Start the session that should use the browser. A [headless session](sessions.md#headless-sessions) suits this well: `joy new ~/code/my-project --headless`.
4. In the extension, pick that session. Leave **Tell the session a browser attached** ticked.

The session now knows a browser is there. Ask it for something that needs one, for example "open the billing page and tell me what plan we are on".

## What happens when the agent uses it

The agent ends its turn with a script between `<joy-browser-execute>` tags. The extension runs the script in the active tab, or in a tab the agent names, or in a new tab at a URL the agent gives. The outcome comes back into the session as a message marked `from="browser"`, with the page it ran on, the value the script returned, and anything it logged. The agent reads that and continues.

Because the result arrives as a new message, each script is one round trip through the [queue](messages.md#the-queue). You can watch the exchange in the app like any other conversation.

While a script runs, Chrome shows a bar saying Joy Browser is debugging the browser. That is how Chrome allows an extension to run a script it was handed, and it disappears when the script finishes.

## What is safe and what is not

- Only the agent's own reply can run a script. Text you type, text another session sends, the agent's thinking, and a tag shown inside a code block never run. A page cannot get a script run by printing one.
- A browser only acts on what the agent writes after you attach it. Earlier messages are ignored.
- A script never runs twice. If the browser closes in the middle of one, the agent gets no answer and may ask again, but a click or a submitted form is not repeated.
- Scripts run in your real browser with your logins. The agent is told to treat page content as data and not to buy, send, submit or delete anything you did not ask for. A hostile page can still try to mislead an agent, so attach the browser to sessions whose task you know, and detach it when you are done.
- Your backup code is your whole account, and the extension keeps it in the browser profile so it can sign in again by itself. Pair only a profile you trust. **Unpair** in the extension removes it.

## If nothing happens

- **The agent never uses the browser.** Sessions learn how from their machine's daemon. Run `joy update` on that machine. For a session that was already running, send `/joy-prompt` to refresh its instructions.
- **A script takes a while to run.** Chrome puts idle extensions to sleep and wakes this one every 30 seconds. Keeping the extension's popup open makes it respond at once.
- **"cannot attach to this tab".** Browser pages such as `chrome://` addresses and the Chrome Web Store cannot be scripted. Have the agent open the page it needs.

## Related

- [Sessions](sessions.md)
- [Messages and the queue](messages.md)
- [Scripting and agents](scripting-and-agents.md)
- [Security](../reference/security.md)
