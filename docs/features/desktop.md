# Desktop apps for chats

`helm desktop` lets a chat see and use desktop apps through their buttons and
fields. Helm runs Vercel's agent-desktop program at the exact version in
`packages/connect/package.json`. Change that number on purpose only, then run
the real check below on Linux and, when one is online, on a Mac.

## Decisions

- **Their program, not their code.** It is Rust and no Helm machine builds
  Rust. Helm calls the native file in the package directly; their Node
  launcher adds a delay to each call.
- **One namespace per chat.** Every call carries `--session helm-<chat id>`,
  so one chat's refs never work in another chat. Their state lives in
  `~/.helm/desktop/tool`, which must stay mode 0700.
- **Owner's apps are safe.** `close` stops only a process that this chat
  opened, checked by its start time, so a reused process number is left
  alone. Their `close-app` closes every copy by name, so chats cannot run it.
  `restart` closes by name: agents ask the owner first.
- **Linux apps show controls only when asked.** `open` gives every app the
  accessibility settings, and Chromium-based browsers also get
  `--force-renderer-accessibility`. Other apps can refuse that option. An app
  that was open before ignores both: it needs a restart.
- **The screen-reader switch** (`org.a11y.Status IsEnabled`) is a last
  resort. Helm turns it off after 10 minutes without desktop use, and only
  when Helm turned it on.
- A deleted chat closes its apps. A settled chat keeps them.

## Traps

- On Wayland their program cannot move the pointer, focus a window or close
  an app politely. It can still read, click, type and set values.
- Their program checks each window against the real display. GTK's hidden
  display (broadway) shows no windows to it, so a hidden test desktop does
  not work.
- Their install step downloads from GitHub only when the bundled files are
  missing or damaged.

## Prove it

- **Tests:** `test/desktop-use`, plus the note and size checks in
  `test/delegation` and `test/help`.
- **Real check (Linux with a screen):** In a private Helm, start a fake chat.
  Open a small GTK3 window titled "Helm test" with an entry and a Save button.
  Use `helm desktop apps`, `look`, `type`, `click` and `close` on it only.
  Never act on the owner's apps.
