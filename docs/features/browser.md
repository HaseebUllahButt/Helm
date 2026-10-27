# Browser for chats

Each chat has its own browser. On a machine with a screen, the owner uses
an external Chromium window. The VM uses hidden Chromium for agent commands.
Helm has no browser panel, Browser button, or browser shortcut.
Design: [`docs/browser-use.md`](../browser-use.md).

## Open the external browser

- **Reach:** Run `helm browser open <url>` in a chat. Use `--session <chat-id>`
  outside a chat. Run `helm browser tabs` to list tabs.
- **Prove:** In a private Helm, open a chat with the fake agent. Check the
  header at phone and desktop sizes. Open a local test page with the CLI.
  Check that Helm keeps the chat visible and sends no browser requests.
  Use `tabs`, `look`, `act`, `point`, `screenshot`, and `close` on that tab.
- **Traps:** Do not open private test tabs on the owner's screen. Use hidden
  Chromium for tests. On niri, the external window needs the `helm-browser`
  window rule. A machine without a screen cannot show the owner a window.
- **Tests:** `test/agent-browser`, `browser-window`, `browser-smarts`,
  `test/browser/agent-browser`, and `test/browser/browser-smarts`.

## Logins and saved flows

- **Reach:** Run `helm browser profiles`, then `helm browser logins "<profile>"`.
  Add `--default` to use those logins for new chats.
- **Not driven:** Copying real browser logins needs the owner's profiles.
- **Tests:** `test/browser-logins`, `test/agent-browser`, and `test/browser-smarts`.
