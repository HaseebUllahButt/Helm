# Browser use

Each chat has its own browser, run with Patchright on the chat's machine.
Open a tab with `helm browser open <url>`.
The owner uses the same browser window. Helm has no browser panel.

## Decisions

- **Any Chromium-based browser.** Helm uses the browser the owner already
  has: Chromium, Chrome, Brave, Edge, Vivaldi or Helium, in that order
  (`browserPaths` in browser-window.js). They all speak Chromium's own
  channel, so the same code drives each one. Helm reads pages as text and
  numbered controls first; screenshots are the last resort. The goal is
  computer use, not one browser: Bowser was removed so the browser path has
  one engine to grow from.
- **It runs on the chat's machine.** The agent CLI reaches it through that
  machine's own local link, so agent actions never cross the phone link,
  and `localhost` reaches dev servers there. Outside an agent chat, pass
  `--session <chat-id>`.
- **A screen found late still counts.** Helm's service can start at boot,
  before the desktop. Each time it needs a window it looks again: its own
  display settings, then the desktop's settings in systemd, then a Wayland
  socket. Once it sees a screen, agent browsers are windows from then on.
  Only the service looks past its own settings (`useDesktopScreen`): tests
  remove the display settings to keep their browsers hidden.
- **One window, a tab per page.** On a machine with a screen every chat's
  tabs share one real browser window with one profile folder (a new window
  starts with the default profile's logins). Helm registers the tabs it
  opens; a popup goes to the chat whose page opened it; a tab the owner
  opens stays theirs. Logins are shared by all chats.
- **No picture in Helm.** The agent drives it
  from inside Chromium, never through the desktop, so it never takes the
  owner's keyboard or mouse. Helm does not show or stream the page. A machine without a screen (the VM) uses a hidden Chromium,
  which is never started where windows can show.
- **Local terminal links use the chat's machine.** Opening a local link
  checks that its server still belongs to the chat, then opens its address
  in the chat's browser window. No public link is made. Discovery runs
  only when the owner opens a link. Paths and queries stay intact.
- **Owner and agent share the window.** When the owner clicks, types or
  scrolls, the agent's next step waits until they are still for 2.5 s (at
  most 20 s). Closing the window keeps its tabs as asleep; listing tabs
  never opens it.
- **It cleans up after itself.** A chat's tabs that nobody used for 10
  minutes close, unless the owner is looking at one; they sleep and come
  back with the next step. The window closes when no chat has a tab there
  and the owner has none of their own. Deleting a chat closes its tabs and
  removes its folder; tidying removes the per-chat windows of before. Windows start with `--disable-component-update`, so a chat's
  profile does not fetch ~150 MB of speech, DRM (Widevine) and model files;
  DRM video does not play there. Some time after Helm starts, closed
  windows lose component downloads and graphics files. Folders of chats gone
  for a day are removed. Cached site files and compiled scripts stay ready
  for repeat visits, including after a window sleeps or Helm restarts.
- **A new tab opens at its address** (`Target.createTarget` with the URL).
  A native browser starts without an unused New Tab page. Helm copies logins
  and sets up owner input first, then opens the requested page.
  A tab Playwright makes starts empty, and Chromium shows "about:blank" over
  a white page until the site answers. A failed load is read from
  Chromium's error page: loading the address again there can leave the tab
  unable to close.
- **An agent gets the page when it goes quiet:** the load event, or half a
  second with no fetch in flight (at most 3 s). Slow pictures and adverts
  no longer hold every step back. Pointer moves and scrolling return without
  waiting for background traffic. The pointer stays visible without a pause
  before each action. Drawing it does not repeat the action's scroll and
  stability checks for a control already in view. Clicks and typing still
  scroll clipped controls and frame targets into view.
- **Show me** (`helm browser point`) highlights an element and changes
  nothing, so it works in read-only chats. Read-only agents can read,
  navigate, wait and check; a batch holding any change is refused before
  its first step.

## Traps

- On niri the window needs this rule (app id `helm-browser`):

  ```kdl
  window-rule {
      match app-id=r#"^helm-browser"#
      open-focused false
  }
  ```

- A Chromium-based browser must already be installed (one from the list
  above, `HELM_CHROMIUM_PATH`, or Playwright's). Helm never downloads one at
  daemon start, and loads no browser driver until a browser is needed. A
  service has a short PATH, so Linux also searches /usr/local/bin, /usr/bin
  and /snap/bin.
- Readiness and launch use the same system browser list. `HELM_WINDOW_CHROMIUM` selects only the visible browser;
  `HELM_CHROMIUM_PATH` selects the hidden browser.
- Chats share no tab limit. Keep every saved tab when Helm restarts.
- Hidden tabs use full Chromium. The headless shell has no native PDF
  plugins or `window.chrome`. Patchright avoids `Runtime.enable` in pages
  and workers. Chromium's automation flag stays off. Hidden tabs use one
  browser version for the user agent and client hints; the CDP connection
  that sets them must stay open, since detaching resets them.
- Console capture starts only when `helm browser act` asks for `console`.
  It reads Chromium's current page buffer, then stops. Reading the console
  can trigger a site's control checks. Logs from an earlier page are not
  kept unless the agent read them before navigation.
- A viewport screenshot captures the visible page without waiting for fonts.
  A full-page screenshot still waits for fonts.
- Each chat's cookies and site storage are saved privately under
  `~/.helm/browser` and come back after a restart. Actions, half-done
  navigation and form contents are not replayed.
- Saved flows are kept only when every step succeeds, in 0600 files at
  `~/.helm/browser/flows/<name>.json`. Use names or selectors in flows, not
  element numbers: numbers change between visits.
- An upload target can be a file field, a CSS selector (file fields are
  often hidden) or a button that opens the file picker. Helm catches the
  picker and gives it the files, so no system dialog opens.
- Downloads stay on the machine while the tab is open. Closing the tab
  removes them. Each file can hold up to 128 MiB.

## Logins

A new window starts with the logins of the profile the owner chose, else
the system default browser's most recently used profile (only in the Helm
service; tests never read real profiles). An agent picks another profile
itself when a site needs it.

`helm browser profiles` lists browser profiles on the chat's machine.
`helm browser logins "<profile>" [--default]` copies cookies from a Helium,
Chromium, Chrome, Brave, Edge or Vivaldi profile into the shared window. The
machine default stores only the profile name.

- A profile is found by any name a person uses: the browser ("helium"),
  the profile ("work", "Profile 7", its email), both ("work in chrome",
  "brave:Default"), the start of a name, or a line pasted from the list.
  When two fit, the system's default browser wins, then the latest used.
  The list shows that order.
- Helium keeps its key in the keyring under "chromium", and its flags in
  `helium-browser-flags.conf`.

- Sites that also need local storage or device-bound keys may still ask to
  sign in through the chat's browser window.
- Linux reads basic, libsecret and KWallet keys; unlock the keyring if
  copying fails. macOS keychain is best effort. Windows app-bound encrypted
  logins cannot be imported.
- Copying needs Node 22.16 or newer (SQLite support).
