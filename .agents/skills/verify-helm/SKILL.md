---
name: verify-helm
description: Prove a Helm change works by driving the real app - a private Helm copy with a free fake agent, opened in a hidden phone-size browser. Use after any change the owner could see or feel (app screens, chats, approvals, helpers, sidebar, settings, daemon behaviour behind them), before saying it works, and when reproducing a reported bug.
---

# Verify Helm for real

Passing tests do not show that the phone streams, that a send lands, or
that a button does what it says. The owner trusts a change only after it
has been run. This skill is how you run it without touching their Helm.

## The loop

```sh
V="node scripts/verify-helm.mjs"
$V up                       # private Helm, its own folder, sockets, port
$V open                     # hidden browser, 390x844 phone, signed in
$V click "New chat"         # by visible text, label or placeholder
$V click "verify-<name>"    # the machine
$V click "No folder · quick chat"
$V click "fake"             # the Fake agent account ("fake-ask" asks first)
$V click "Ask anything"; $V type "hello"; $V click send
$V wait "done."            # the fake agent's reply: "working on it done."
$V shot                     # prints the PNG path; look at it with Read
$V errors                   # page errors and console errors seen so far
$V down                     # stops only what this copy started, deletes it
```

Other commands: `text` (visible page text), `key <key>` (`Enter`,
`Control+n`, `Escape`), `upload <file>...` (attach files), `eval <js>`,
`size <w> <h>`, `open '#open=<machine>/<chat>'` (start on a screen),
`open --desktop` (1280x800, not a phone), `logs [n]` (the daemon's log), and
`rpc <method> [json]` to ask the private Helm directly (`session.list`, for
example) when setting up state by clicking would be slow.

Each chat gets its own copy, named after its Helm session, so parallel
agents never share one. `--name <name>` picks another.

## What to check

1. Find the feature in `docs/features/` - where the owner reaches it and
   what counts as proof.
2. Drive the change the way the owner would, at phone size first, then
   `size 1280 800` if it also has a desktop layout.
3. Look at every screenshot you take. Read `errors` before saying done.
4. Report what you drove and what you saw, and name anything you could not
   drive. "Tests pass" is not "it works".

## Accounts

- **fake** answers every message after 0.8 s ("working on it done.") and
  costs nothing.
- **fake-ask** first asks to run `echo hi` (Approve / Always allow /
  Decline), for approval cards.
- `up --real` adds the owner's real logins. Use one only when the change is
  about that CLI itself (its driver, its models, its output). A real chat
  costs money and lands in that account's history: keep it in a quick chat,
  and delete it after.

## Traps

- The private copy has its own home folder, so it shows none of the
  owner's chats. With `up --real` it shows **the owner's real chats and
  terminals**: never delete, stop, rename or message anything you did not
  create.
- A yellow "Helm updates need attention" banner shows while the checkout
  has uncommitted edits. Ignore it, and never press "Replace with GitHub's
  version" there: the private copy runs from the real checkout.
- On phone size, Enter and Ctrl+Enter in the composer make a new line.
  Press the button labelled `send`. Its placeholder changes, so click
  "Ask anything".
- The fake agent ignores Stop, never asks questions (only tool approvals)
  and cannot take images. Prove those with a real chat or the tests.
- `wait` reads page text, not what is inside a text box.
- The folder step does not take a full path; use the quick-chat row.
- Never stop Helm processes by name (`pkill -f`, `systemctl stop
  helm-...`): those names match the owner's real Helm too. `down` finds
  this copy's processes by its folder.
- Speed numbers from the private copy are not the owner's numbers: there is
  no network between machines here.

When the steps for a feature are wrong or missing, fix them in
`docs/features/` in the same change.
