# Browser for chats

Each chat has its own browser. On a machine with a screen it is a real
Chromium window beside Helm that never takes the keyboard; on the VM it is
hidden. The panel in Helm is its remote control; there is no picture of the
page in Helm. Full notes: `docs/browser-use.md`.

## Open the browser panel
- **Sees:** chat header **Browser** button (globe). Panel: "Browser · Hidden, on <machine>", back / forward /
  reload, "Search or type an address", **New tab**, a key icon for logins.
  Empty: "No tabs yet. Agents on <machine> browse here, out of sight;
  localhost reaches servers there." On a wide screen it docks on the right.
- **Reach:** **Browser** or Ctrl/⌘+Shift+B. The header button is on
  computers only: on a phone (touch screen) it is hidden, since the owner
  does not watch the browser from the phone, so a phone has no way in
  (the Thread details → Browser tab was removed 2026-10-17).
- **CLI:** `helm browser open <url> [--engine bowser]`, `helm browser tabs`,
  `look <tab>`, `act <tab> '<json>'`, `screenshot`, `point`, `close`.
- **Prove (panel driven 2026-10-15, tabs not yet driven):**
  ```sh
  $V click Browser           # the header button; the phone-size browser is not a touch screen
  $V text                    # "No tabs yet. Agents on verify-<you> browse here…"
  ```
- **Proof:** the empty panel text above.
- **Traps:** Do not open tabs from the private
  copy on the laptop: a tab may open a real Chromium window on the owner's
  screen. On niri the window needs the `helm-browser` window rule.
- **Tests:** `test/browser/agent-browser`, `browser-window`,
  `browser-smarts`; `test/agent-browser`, `browser-window`,
  `browser-smarts`.

## Logins
- **Sees:** the key icon → copy the owner's browser profile logins into the
  chat's browser, instead of typing passwords.
- **Prove:** steps not yet driven; it reads real browser profiles.
- **Tests:** `test/browser-logins`; `test/browser/browser-logins`.

## Show me (point)
- **Sees:** a highlight with a note on a page element; nothing is clicked.
- **CLI:** `helm browser point <tab> <ref|selector> --note "Click here"`.
- **Prove:** steps not yet driven.
- **Tests:** `test/agent-browser`.

## Saved flows
- **Sees:** nothing in the app; agents save repeat steps and replay them.
- **CLI:** `helm browser flows`, `helm browser run <tab> <name> key=value`.
- **Prove:** steps not yet driven.
- **Tests:** `test/browser-smarts`.
