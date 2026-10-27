# Browser use

Each chat has its own browser, run with Patchright on the chat's machine.
It controls web pages only, not desktop apps. Open it with a chat's
**Browser** button or Ctrl/⌘+Shift+B.

## Decisions

- **It runs on the chat's machine.** The agent CLI reaches it through that
  machine's own local link, so agent actions never cross the phone link,
  and `localhost` reaches dev servers there. Outside an agent chat, pass
  `--session <chat-id>`.
- **A real window, no picture in Helm.** On a machine with a screen each
  chat's browser is a real Chromium window with its own profile folder (a
  new chat starts with the default profile's logins). The agent drives it
  from inside Chromium, never through the desktop, so it never takes the
  owner's keyboard or mouse. The Helm panel is only a remote; nothing is
  streamed. A machine without a screen (the VM) uses a hidden Chromium,
  which is never started where windows can show.
- **Owner and agent share the window.** When the owner clicks, types or
  scrolls, the agent's next step waits until they are still for 2.5 s (at
  most 20 s). Closing the window keeps its tabs as asleep; listing tabs
  never opens it.
- **It cleans up after itself.** A window nobody used for 30 minutes
  closes, unless the owner is looking at it; its tabs sleep and come back
  with the next step. Deleting a chat closes its window and removes its
  folder. Windows start with `--disable-component-update`, so a chat's
  profile does not fetch ~150 MB of speech, DRM (Widevine) and model files;
  DRM video does not play there. Some time after Helm starts, closed
  windows lose the files Chromium fetches again, and folders of chats gone
  for a day are removed.
- **A new tab opens at its address** (`Target.createTarget` with the URL).
  A tab Playwright makes starts empty, and Chromium shows "about:blank" over
  a white page until the site answers. A failed load is read from
  Chromium's error page: loading the address again there can leave the tab
  unable to close.
- **An agent gets the page when it goes quiet:** the load event, or half a
  second with no fetch in flight (at most 3 s). Slow pictures and adverts
  no longer hold every step back. Pointer moves and scrolling return without
  waiting for background traffic. The pointer stays visible without a pause
  before each action.
- **Show me** (`helm browser point`) highlights an element and changes
  nothing, so it works in read-only chats. Read-only agents can read,
  navigate, wait and check; a batch holding any change is refused before
  its first step.

## Traps

- On niri the window needs this rule (app id `helm-browser-<chat>`):

  ```kdl
  window-rule {
      match app-id=r#"^helm-browser"#
      open-focused false
  }
  ```

- Chromium must already be installed (an existing browser,
  `HELM_CHROMIUM_PATH`, or Playwright's). Helm never downloads one at daemon
  start, and loads no browser driver until a browser is needed.
- Hidden tabs use full Chromium. The headless shell has no native PDF
  plugins or `window.chrome`. Patchright avoids `Runtime.enable` in pages
  and workers. Chromium's automation flag stays off. Hidden tabs use one
  browser version for the user agent and client hints; the CDP connection
  that sets them must stay open, since detaching resets them.
- Console capture starts only when `helm browser act` asks for `console`.
  It reads Chromium's current page buffer, then stops. Reading the console
  can trigger a site's control checks. Logs from an earlier page are not
  kept unless the agent read them before navigation.
- The panel receives title and load changes with browser events. Its
  two-second list check remains a fallback. A viewport screenshot captures
  the visible page without waiting for fonts; a full-page screenshot still
  waits for fonts.
- Each chat's cookies and site storage are saved privately under
  `~/.helm/browser` and come back after a restart. Actions, half-done
  navigation and form contents are not replayed.
- Saved flows are kept only when every step succeeds, in 0600 files at
  `~/.helm/browser/flows/<name>.json`. Use names or selectors in flows, not
  element numbers: numbers change between visits.
- Downloads over 8 MiB (up to 128 MiB) stay on the machine only while the
  tab is open; closing the tab removes them.

## Logins

**Logins** in the panel copies only cookies from a Helium, Chromium, Chrome,
Brave, Edge or Vivaldi profile on the chat's machine (`helm browser profiles`,
`helm browser logins "<profile>" [--default]`). The machine default stores
only the profile name; cookies live only in each chat's private storage.

- A profile is found by any name a person uses: the browser ("helium"),
  the profile ("work", "Profile 7", its email), both ("work in chrome",
  "brave:Default"), the start of a name, or a line pasted from the list.
  When two fit, the system's default browser wins, then the latest used.
  The list shows that order.
- Helium keeps its key in the keyring under "chromium", and its flags in
  `helium-browser-flags.conf`.

- Sites that also need local storage or device-bound keys may still ask to
  sign in through the viewer.
- Linux reads basic, libsecret and KWallet keys; unlock the keyring if
  copying fails. macOS keychain is best effort. Windows app-bound encrypted
  logins cannot be imported.
- Copying needs Node 22.16 or newer (SQLite support).

## Bowser

With `bowser-computer` installed (or `HELM_BOWSER_PATH`), `--engine bowser`
reuses Bowser's browser and logins through one lasting MCP bridge. Bowser's
own human pause stays in charge: Helm never resumes it. The Bowser tab
belongs to one Helm chat at a time, and does not support Show me.
