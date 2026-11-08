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
- **Found by evidence, not names:** Helm uses any Chromium-based browser the
  owner has, even an unfamiliar one. It finds programs with Chromium resources
  beside them (not Electron apps) and user-data folders by their "Local State"
  file, on Linux, macOS and Windows (`chromium-find.js`). No brand-name lists.
- **Tests:** `test/chromium-find`, `test/agent-browser`, `browser-window`,
  `browser-smarts`, `browser-queue`, `test/browser/agent-browser`, and
  `test/browser/browser-smarts`.
- **Speed checks:** The first native window opens only the requested page,
  with copied logins already present. Reopening a sleeping window reuses
  cached site files. Pointer checks cover clipped controls and frame targets.

## Logins and saved flows

- **Reach:** Run `helm browser profiles`, then `helm browser logins "<profile>"`.
  Add `--default` to use those logins for new chats.
- **Not driven:** Copying real browser logins needs the owner's profiles.
- **Found by evidence:** profiles are every "Local State" folder under the
  config roots (Linux ~/.config, ~/.var/app, ~/snap; macOS Application Support;
  Windows %LOCALAPPDATA%), named by their folder. No brand-name lists. Each
  profile's key holds a hash of its full data-folder path, so a saved default
  or cached cookies never move to another account when a browser is installed.
  Keys an older Helm saved ("chrome:Default") map to that one folder or are
  refused. The system default browser is matched by its app id or name.
- **Tests:** `test/browser-logins`, `test/browser-starting-logins`, `test/chromium-find`, `test/agent-browser`, and `test/browser-smarts`.

## Extended mode (the owner's own browser)

- **Reach:** on by default on a machine with a screen. The Helm service
  names the add-on in the browser's flags file at each start, so the
  browser loads it on its next start. An agent runs
  `helm browser mode extended --restart` only when the owner asks.
  `helm browser mode` shows the state; `helm browser mode window` turns it
  off. Settings > a machine > Your browser shows the same state, with
  Restart now, Set up (Google Chrome, Edge), Use my browser and Turn off.
  `helm browser setup` is Set up for an agent, only when the owner asks.
- **Prove:** a real Chromium with the add-on loaded, driven through
  `BrowserManager`: open, look, type, click, check, screenshot, a Helm
  restart that keeps the tab, the way back to window mode, and a tab that
  opens in Helm's window first and moves to the owner's browser once it
  connects.
- **Prove the row:** `verify-helm`, open the machine's settings, click
  Use my browser. Never click Restart now in a private copy: it restarts
  the owner's real browser.
- **Traps:** never test on the owner's own browser profile or flags file.
  Tests start a headless Chromium with its own profile and
  `--load-extension`; only the service (no `HELM_NO_SERVICE`) writes the
  flags file.
- **Tests:** `test/browser-extension`, `test/chromium-find`.
