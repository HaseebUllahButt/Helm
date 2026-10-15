# Spins: public links (`helm share`)

The owner calls these "spins". A spin is a public https link to a port on
one of their machines, served by the VM. It ends by itself after 3 hours
unless kept.

## Share a port
- **Sees:** Settings → **Public links**: "A link shows something running on
  one of your machines. It ends by itself after 3 hours unless it was kept."
  One section per machine, each link as "<name> · port 3000 · open to
  anyone with the link · ends in 2h 59m" with an open arrow and **Stop**.
  **Share a port** opens a form: Port, Name, Password, and a private choice.
- **Reach:** Settings (Ctrl/⌘+Shift+S) → Public links, or the palette
  ("Public links").
- **CLI:** `helm share <port> [--name <n>] [--password [pw]] [--private]
  [--for <hours>] [--keep]`, `helm share list`, `helm share stop <name>`,
  `helm forward <machine> <port> [--local <port>]`.
- **Prove (driven 2026-10-15):**
  ```sh
  $V rpc share.add '{"port":9,"name":"mytest"}'      # "url": null here
  $V key Control+Shift+s; $V click "Public links"; $V text
  $V click Stop; $V rpc share.list                    # "shares": []
  ```
- **Proof:** "mytest · port 9 · open to anyone with the link · ends in 2h
  59m", then after Stop "Nothing shared from verify-<you>." and an empty
  list.
- **Traps:** the private copy has no VM, so links never get an address:
  `url` is null and the page says "No machine in your network has a public
  address yet". A real link needs the real network; use `--private` or
  `--password` for anything not meant for the public, and stop it when done.
  `--keep` only when the owner asks.
- **Tests:** `test/share-links`, `share-private`, `share-expiry`,
  `share-flow`, `tunnel-flow`, `tunnel-ports`, `caddy`, `proxy`;
  `test/browser/private-links`.

## Private links
- **Sees:** a private link opens only on devices signed in to the owner's
  Helm; the open arrow signs the device in first.
- **Prove:** steps not yet driven; needs the VM.
- **Tests:** `test/share-private`; `test/browser/private-links`.

## Forward a shared port
- **Sees:** nothing in the app; another machine's shared port opens on this
  machine's localhost.
- **CLI:** `helm forward <machine> <port>`.
- **Prove:** steps not yet driven; needs two machines.
- **Tests:** `test/tunnel-ports`.
