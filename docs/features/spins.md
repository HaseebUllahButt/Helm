# Spins: public links (`helm share`)

The owner calls these "spins": a public https link to a port on one of
their machines, served by the VM. It ends by itself after 3 hours unless
kept.

## Share a port
- **Prove (driven 2026-10-15):**
  ```sh
  $V rpc share.add '{"port":9,"name":"mytest"}'      # "url": null here
  $V key Control+Shift+s; $V click "Public links"; $V text
  $V click Stop; $V rpc share.list                    # "shares": []
  ```
- **Proof:** "mytest · port 9 · open to anyone with the link · ends in 2h
  59m", then after Stop "Nothing shared from verify-<you>.".
- **Traps:** the private copy has no VM, so `url` is null and the page says
  "No machine in your network has a public address yet". A real link needs
  the real network; use `--private` or `--password` for anything not meant
  for the public, and stop it when done. `--keep` only when the owner asks.
- **Tests:** `test/share-links`, `share-private`, `share-expiry`,
  `share-flow`, `tunnel-flow`, `tunnel-ports`, `caddy`, `proxy`;
  `test/browser/private-links`.

## Private links and `helm forward`
- **Not yet driven;** needs the VM and two machines.
- **Tests:** `test/share-private`, `tunnel-ports`;
  `test/browser/private-links`.
