# Browser for chats

Each chat has its own browser: a real Chromium window beside Helm on a
machine with a screen, hidden on the VM. Helm's panel is only a remote.
Design: [`docs/browser-use.md`](../browser-use.md).

## Open the browser panel
- **Reach:** **Open browser** in the chat's ⋯ menu, or Ctrl/⌘+Shift+B. The
  header shows a Browser button only while the panel is open or the agent opened
  a tab. Computers only: a phone has no way in, on purpose (the owner does
  not watch the browser from the phone).
- **Prove (panel driven 2026-10-15, tabs not yet driven):**
  `$V click Browser; $V text` shows "No tabs yet. Agents on verify-<you>
  browse here…" (the phone-size browser is not a touch screen).
- **Traps:** do not open tabs from the private copy on the laptop: a tab may
  open a real Chromium window on the owner's screen. On niri the window
  needs the `helm-browser` window rule.
- **Tests:** `test/agent-browser`, `browser-window`, `browser-smarts` (each
  also under `test/browser/`).

## Logins, Show me, saved flows
- **Not yet driven;** Logins reads real browser profiles.
- **Tests:** `test/browser-logins`, `test/browser/browser-logins`,
  `test/agent-browser`, `browser-smarts`.
