# Browser use

Each chat has its own browser, run with Playwright on the chat's machine.
It controls web pages. Open a tab with `helm browser open <url>`.
The owner uses the external Chromium window. Helm has no browser panel.

## Decisions

- **It runs on the chat's machine.** The agent CLI reaches it through that
  machine's own local link, so agent actions never cross the phone link,
  and `localhost` reaches dev servers there. Outside an agent chat, pass
  `--session <chat-id>`.
- **A real window, no picture in Helm.** On a machine with a screen each
  chat's browser is a real Chromium window with its own profile folder (a
  new chat starts with the default profile's logins). The agent drives it
  from inside Chromium, never through the desktop, so it never takes the
  owner's keyboard or mouse. Helm does not show or stream the page.
  A machine without a screen (the VM) uses a hidden Chromium,
  which is never started where windows can show.
- **Owner and agent share the window.** When the owner clicks, types or
  scrolls, the agent's next step waits until they are still for 2.5 s (at
  most 20 s). Closing the window keeps its tabs as asleep; listing tabs
  never opens it.
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
  start, and loads no Playwright code until a browser is needed.
- Hidden tabs prefer Playwright's `chromium_headless_shell` (fast, half the
  memory). It has no `window.chrome`, so some bot checks refuse it; set
  `HELM_CHROMIUM_PATH` to pin a full browser.
- Each chat's cookies and site storage are saved privately under
  `~/.helm/browser` and come back after a restart. Actions, half-done
  navigation and form contents are not replayed.
- Saved flows are kept only when every step succeeds, in 0600 files at
  `~/.helm/browser/flows/<name>.json`. Use names or selectors in flows, not
  element numbers: numbers change between visits.
- Downloads stay on the machine while the tab is open. Closing the tab
  removes them. Each file can hold up to 128 MiB.

## Logins

`helm browser profiles` lists browser profiles on the chat's machine.
`helm browser logins "<profile>" [--default]` copies cookies from a
Chromium, Chrome, Brave, Edge or Vivaldi profile. The machine default stores
only the profile name; cookies live only in each chat's private storage.

- Sites that also need local storage or device-bound keys may still ask to
  sign in through the external Chromium window.
- Linux reads basic, libsecret and KWallet keys; unlock the keyring if
  copying fails. macOS keychain is best effort. Windows app-bound encrypted
  logins cannot be imported.
- Copying needs Node 22.16 or newer (SQLite support).

## Bowser

With `bowser-computer` installed (or `HELM_BOWSER_PATH`), `--engine bowser`
reuses Bowser's browser and logins through one lasting MCP bridge. Bowser's
own human pause stays in charge: Helm never resumes it. The Bowser tab
belongs to one Helm chat at a time, and does not support Show me.
