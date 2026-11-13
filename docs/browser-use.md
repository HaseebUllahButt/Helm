# Browser use

Each chat has its own browser, run with Patchright on the chat's machine.
Open a tab with `helm browser open <url>`.
The owner uses the same browser window. Helm has no browser panel.

## Decisions

- **Any Chromium-based browser, found by evidence, not by name.** Helm uses
  the browser the owner already has, even one it has never heard of. It never
  matches brand names: it finds programs with Chromium resources
  (`resources.pak` or `chrome_100_percent.pak`) beside them and rejects
  Electron apps (which carry `resources/app.asar`), from menu entries on
  Linux, app bundles on macOS and the registry on Windows (`chromium-find.js`).
  A packaged browser keeps its launcher: a Snap starts through its
  `/snap/bin` wrapper, a Flatpak through `flatpak run <id>`, so it runs inside
  its own runtime. The saved main browser is preferred, then the system default, then the rest by name. They all
  speak Chromium's own channel, so the same code drives each one. Helm reads
  pages as text and numbered controls first; screenshots are the last resort. The goal is
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
- **Another machine's browser (`--machine <name>`).** A machine with no
  screen (the VM) gets more CAPTCHAs: sites see a hidden browser on a
  server address. A chat there can use the owner's signed-in browser on
  another machine. That machine keeps the tabs as a guest chat,
  `guest-<machine>-<chat>`, made from the caller's `guest` field (its chat,
  machine, mode and title). Read-only chats stay read-only there. Settings,
  mode, main browser, login copies and terminal links refuse guests. A
  CAPTCHA notice opens the caller's chat. A machine on an older Helm answers
  "thread not found", which the command turns into "update it".
- **A command tool before a website.** The agent note tells agents to use a
  service's own command tool or API key (Cloudflare, GitHub) before its
  website: no login page and no CAPTCHA.
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
- **A read covers every frame, and a number keeps its element.** Frames are
  read through Playwright's own frame targets, so cross-origin frames are
  there too. A frame whose place or content does not answer in 2 s (a busy
  frame) is named, not waited for. Each frame document numbers its own
  elements; Helm maps each one to a tab number once, so a late or
  overlapping read never gives one number to two elements. An old number
  reaches the same control or is refused. A read lists up to 300 controls
  and says when it cut the list; `within` or `frame` reads the rest.
- **Fail fast, and never deliver twice.** A step waits up to 2 s for its
  control, a page load 10 s, a call 30 s; `timeout` raises one. One step
  deadline covers finding the control, the pointer and the input, and never
  runs past its call's. No input or pointer scroll goes out once its step
  or its call is out of time; finding frames shares one deadline too. A check reads again until it holds; each read gets only the time
  left, a result seen after the deadline does not count, and a page or
  frame that did not answer (or whose place could not be read) makes it
  "could not be checked", never a pass. Helm never adds a check or a retry of input on its own.
  A call that times out delivers no later batch step, and its reply says
  if the step in flight may have landed. Until that step ends, only reads
  run on the tab (an `evaluate` that never returns: close the tab).
- **A modal dialog stops page reads.** The input that opened it is held
  until it is answered. Reads and checks then report the dialog without
  reading the page, and a check of the dialog skips the tab's queue.
- **A script runs in the agent's own process.** `helm browser script`
  runs the agent's JavaScript, with ifs and loops, in its CLI process, never
  in the Helm service. Each step is the same `browser.action` call as
  `act`, so read-only chats, owner-quiet waits, step timeouts and extended
  mode stay as they are, and agent code gets no new power. A script step
  does not read the page after it (`"look": false`); a failed step or
  script still answers with a page read. A script has no step count limit
  and no time limit unless `--timeout`. The idea comes from Browser Use
  (MIT), where the model writes Python cells.
- **Show me** (`helm browser point`) highlights an element and changes
  nothing, so it works in read-only chats. Read-only agents can read,
  navigate, wait and check; a batch holding any change is refused before
  its first step.
- **The owner solves a CAPTCHA; Helm never does.** No outside service
  either: Browser Use's free code only waits for their paid cloud. Each read
  names a visible CAPTCHA (`captcha` field and one line), found by frame
  address and by element in the frames it already reads. `helm browser
  captcha <tab>` points at it, sends the same notice as a question, and
  reads until an answer field has a value or the CAPTCHA is gone twice in a
  row. It skips the tab's queue. A hub call ends after 130 s, so the CLI
  waits in calls of 100 s. Without a screen it stops at once.

## Extended mode: the owner's own browser

Extended mode is the default on a machine with a screen: agents use the
owner's own browser, with its real logins, site data and add-ons, through
Helm's add-on (`packages/connect/browser-extension`). The owner asks for a
task on a signed-in site, and the agent does it with no login from the
owner. `helm browser mode window` turns it off; only a choice saved with a
version (`mode.json` `v: 2`) counts, so the first add-on's test files do not.
The idea comes from opencode's Browse (MIT).

- **A closed browser is started.** When the owner's browser is closed and
  supports command-line add-ons, Helm starts it with
  `--no-startup-window`, the add-on folder and the flag that hides the debugging bar and waits up to 20 s for the add-on. Agents then
  work in the owner's real profile, never in a copy of its logins.
- **Until the browser connects, Helm's window.** When the add-on is still
  not connected, the chats' tabs open in Helm's window, and `open` says why
  and what to do. Only a link that just opened waits for the add-on (4 s). When
  the add-on connects, Helm's window closes after the current step; the
  tabs open again in the owner's browser by address.

- **The same driver in both modes.** The add-on drives tabs through
  `chrome.debugger`. `browser-relay.js` makes that look like a Chromium
  debugging port, and Patchright connects to it as to Helm's window. So
  look, act, point, checks and flows work the same.
- **Only Helm's tabs.** The add-on attaches only to tabs it opened and to
  popups from them. They open in the background, in a folded "Helm" tab
  group. The owner's other tabs are never visible to Helm.
- **The profile the owner names.** Each open profile runs its own copy of
  the add-on, and each copy connects with its own mark. Helm finds the
  profile folder by that mark in the add-on's storage files there
  (`Local Extension Settings/<id>`); no four letters repeat in a mark, so
  the storage never compresses it. `helm browser open <url> --profile
  <name>` opens the tab in that profile, and the chat keeps it (also in
  `<chat>/profile.json`). With no name: the chat's profile, the owner's
  default login profile when it is open, the profile used last, then the
  first that connected. A profile with no open window loads in the running
  browser (`--profile-directory=<dir> --no-startup-window`): no restart,
  and one window that does not take the focus. A named profile never falls
  back to another one. All copies must come from one browser.
- **Nothing leaves the owner's browser.** Helm never writes or reads its
  cookies: login copying, cookie saving and browser-wide cookie, cache,
  close and window-raise commands are refused or skipped.
- **The add-on proves itself.** The link listens on 127.0.0.1 only. Helm
  writes a new key and port to `helm-link.json` in the add-on folder at each
  start. The add-on and Helm each sign a fresh challenge with the key, and
  the page origin must be the add-on's fixed id. The driver end needs a
  random token. One browser connects at a time, one link per profile.
- **New tabs start blank.** A new tab goes to its address only after the
  driver has set the page up (on `Runtime.runIfWaitingForDebugger`), so
  Helm's page scripts run on the first page too.
- **Background screenshots.** A hidden tab draws nothing, so a screenshot
  can wait forever. The link sends small extra captures to release it.
- **Main browser.** `helm browser main` lists the installed browsers and marks
  the browser in use. `helm browser main <name>` saves a choice, without regard
  to letter case. Settings > this machine > Your browser has the same choice.
  A saved, installed browser wins over the system default. If it is absent,
  Helm uses the system default, then the first found. Without a saved choice
  or a readable default, `open` asks the agent to ask the owner once, while
  continuing the task. Choices use `mode.json` version 2 and survive mode changes.
- **Setup at each start.** The service copies the add-on into Helm's browser
  folder. A launcher with a flags file gets the folder added to its existing
  `--load-extension` list. On Linux, a browser without a flags file gets a
  user menu entry with the same file name. Its Exec lines keep the package
  launcher (including Flatpak), other add-ons and owner flags. A marker saves
  the original entry for removal. Helm also passes the add-on folder and
  `--silent-debugger-extension-api` whenever it starts a supported browser,
  on Linux, Windows and macOS. A running browser loads no new add-on from a
  second start. Agents never close, restart or start the owner's browser, and
  never give it a debugging port: on 2026-11-13 a chat did that to reach a
  profile, and the owner called it unacceptable. `helm browser mode` has no
  restart switch. Until the next start, agents use Helm's window. Only the
  owner's Restart now button in Settings restarts it, with its last tabs.
- **Changing browsers.** Helm removes its old flags or menu change, saves
  agent tabs asleep, and stops the old link. Each chosen browser has its own
  add-on folder and link, so the old browser cannot take the new link. The
  next agent step opens its tabs through the chosen browser when it connects.
- **Chromium writes its command line as one line.** `/proc/<pid>/cmdline`
  of a running Chromium has spaces, not NULs, between its flags. Read
  `--type=` and `--user-data-dir=` after a space too, or a restart closes
  every Chromium on the machine, Helm's windows among them.
- **Helm's app window loads no add-ons.** Its launcher starts the same
  browser launcher, which reads the flags file. Without
  `--disable-extensions` the add-on would connect from the app window first
  (one browser at a time) and agents would drive tabs there.
- **No debugging bar.** While the add-on drives a tab, Chromium shows
  "Helm started debugging this browser" on every tab. Helm adds
  `--silent-debugger-extension-api` to the flags file, with a marker line,
  and the way back takes out only its own line.
- **Google Chrome and Edge: one step from the owner.** Since Chrome 137
  they ignore `--load-extension` (malware used it), and Helm must not
  depend on the Chrome Web Store. Settings > Your browser > Set up opens
  `chrome://extensions` in the owner's browser and copies the folder; the
  owner turns on Developer mode, clicks Load unpacked and pastes. The
  add-on connects at once, with no restart. Agents never stop a task for
  it: they work in Helm's window and point the owner to Settings once.
  Helm does not add launch flags or menu changes to these browsers; their debugging bar stays.
- **Restarts.** An add-on of another version loads Helm's copy when it
  connects. The add-on keeps its tabs when Helm restarts and reconnects
  every second for a minute, then every 30 s. Helm takes the tabs back by
  address, as with its own window. When the add-on disconnects, the chats'
  tabs go to sleep.
- **Way back.** `mode window` takes Helm's folder out of the flags file or menu entry,
  closes the add-on's tabs and keeps them asleep. They open again in Helm's
  window.

## Traps

- On niri the window needs this rule (app id `helm-browser`):

  ```kdl
  window-rule {
      match app-id=r#"^helm-browser"#
      open-focused false
  }
  ```

  That rule covers only the window opening. A foreground tab makes Chromium
  ask the desktop for focus, and a desktop that honours any request (niri's
  `honor-xdg-activation-with-invalid-serial`) gives it. So Helm opens every
  tab in its window in the background and keeps it drawing with a tiny
  screen feed. Only owner steps (`point`, CAPTCHA) bring a tab to the front.

- A Chromium-based browser must already be installed (any one, found by
  evidence, `HELM_CHROMIUM_PATH`, or Playwright's). Helm never downloads one at
  daemon start, and loads no browser driver until a browser is needed. On
  Linux it reads menu entries and follows start scripts, Flatpak and Snap to
  the real program; a service has a short PATH, so it also searches
  /usr/local/bin, /usr/bin and /snap/bin.
- Readiness and launch use the same discovery. `HELM_WINDOW_CHROMIUM` selects only the visible browser;
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
