---
name: verify-helm
description: Prove a Helm change works by driving the real app - a private Helm copy with a free fake agent, opened in a hidden phone-size browser. Use after any change the owner could see or feel (app screens, chats, approvals, helpers, sidebar, settings, daemon behaviour behind them), before saying it works, and when reproducing a reported bug.
---

# Verify Helm for real

Passing tests do not show that a send lands or a button works. The owner
trusts a change only after it has been run. This runs it without touching
their Helm.

## The loop

```sh
V="node scripts/verify-helm.mjs"
$V up                       # private Helm, its own folder, sockets, port
$V open                     # hidden browser, 390x844 phone, signed in
$V click "New chat"         # by visible text, label or placeholder
$V click "verify-<name>"    # the machine
$V click "No folder · sketch"
$V click "fake"
$V click "Ask anything"; $V type "hello"; $V click send
$V wait "done."             # the fake reply: "working on it done."
$V shot                     # prints the PNG path; look at it with Read
$V errors                   # page and console errors seen so far
$V down                     # stops only what this copy started, deletes it
```

Use `$V restart` to replace only the private daemon while its agents keep running.

Also: `record start|stop`, `compare`, `text`, `key <key>`, `upload <file>...`, `eval <js>`, `size <w> <h>`,
`open '#open=<machine>/<chat>'` or `open '#devices'`, `open --desktop`
(1280x800, mouse and hover; `open --phone` goes back - each starts a fresh
browser of that kind, `size` alone keeps the phone's touch rules), `logs [n]`, `status`, and `rpc <method> [json]` to set up state
without clicks (methods are in `packages/protocol/index.js`). Each chat gets
its own copy, named after its Helm session; `--name <name>` picks another.

## What to check

1. Find the feature in `docs/features/`: how to reach it, what is proof.
2. Drive it as the owner would, at phone size first, then `size 1280 800`
   if it has a desktop layout.
3. Look at every screenshot. Read `errors` before saying done.
4. Show the owner one proof in the chat, so they see it work in seconds.
   Keep every other screenshot private.
   - A change to how a screen looks: `$V shot before.png` before you edit
     the code, `$V shot after.png` after, then
     `$V compare before.png after.png pair.png --before "Before: <what>" --after "After: <what>"`.
   - A change to how something works (clicks, sends, approvals): `$V record
     start`, do the steps, `$V record stop clip.webp`. Keep it under about
     15 s; over 2 MB it is too big to show.
   - Show it with `helm render <file> --title "<what it proves>"`.
5. Report what you drove and saw, and name what you could not drive.
   "Tests pass" is not "it works".

## Accounts

- **fake** answers after 0.8 s and costs nothing.
- **fake-ask** first asks to run `echo hi` (Approve / Always allow /
  Decline).
- **fake-pics** takes pictures.
- **fake-slow** works for 2 minutes before answering.
- `up --real` adds the owner's real logins. Use one only when the change is
  about that CLI itself. A real chat costs money and lands in that account's
  history: keep it in a sketch, and delete it after.

## Traps

- Build the web app before `up` if `apps/web/dist/index.html` is missing:
  `npm --workspace @helm/web run build`. A copy started before the first
  build serves a missing page until `restart`, even after the build exists.
- The copy has its own home (`/tmp/helm-verify-<name>/home`). With
  `up --real` it uses the real home and shows **the owner's real chats,
  terminals, spend and search results**: never delete, stop, rename or
  message anything you did not create.
- Run `helm` against the copy only with its `HELM_DIR` (see
  `docs/features/README.md`); without it you talk to the owner's real Helm.
- Ignore the yellow "Helm updates need attention" banner, and never press
  "Replace with GitHub's version": the copy runs from the real checkout.
- On phone size Enter makes a new line; press `send`. The placeholder
  changes, so click "Ask anything" (a part match). `type` refuses when
  nothing has focus.
- `click` prefers exact matches and skips things under a sheet or menu.
  `open` always reloads. `text` can miss an open menu; `wait` does not read
  text boxes.
- The fake agent ignores Stop, never asks questions, and asks again after
  "Always allow". Prove those with a real chat or the tests.
- The folder step does not take a full path; use the sketch row.
- Never stop Helm processes by name (`pkill -f`, `systemctl stop
  helm-...`): that matches the owner's real Helm. `down` finds this copy's
  processes by its folder.
- Always `down` when done. `up` also clears other copies whose Helm stopped
  or that no command used for 12 hours.
- Speed here is not the owner's speed: there is no network between machines.

When the steps for a feature are wrong or missing, fix them in
`docs/features/` in the same change.
