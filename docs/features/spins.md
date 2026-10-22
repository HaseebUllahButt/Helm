# Spins: public links (`helm share`)

The owner calls these "spins": a public https link to a port on one of
their machines, served by the VM. It ends by itself after 3 hours unless
kept. `helm spin` is an alias of `helm share`. An agent can open a link
beside chat with `helm canvas <spin-url>`. The new-tab link remains available
for websites that cannot run inside a frame.

## Share a port
- **Prove:** start a test app on port 5173, then:
  ```sh
  $V rpc share.add '{"port":5173,"name":"mytest"}'   # "url": null here
  $V key Control+Shift+s; $V click "Public links"; $V text
  $V click Stop; $V rpc share.list                    # "shares": []
  ```
- **Proof:** "mytest · port 5173 · open to anyone with the link · ends in 2h
  59m", then after Stop "Nothing shared from verify-<you>.".
- **Traps:** start the app before sharing it; Helm checks both loopback
  addresses and refuses a closed port. The private copy has no VM, so `url` is null and the page says
  "No machine in your network has a public address yet". A real link needs
  the real network; use `--private` or `--password` for anything not meant
  for the public, and stop it when done. `--keep` only when the owner asks.
- **Tests:** `test/share-links`, `share-private`, `share-expiry`,
  `share-flow`, `tunnel-flow`, `tunnel-ports`, `caddy`, `proxy`;
  `test/browser/private-links`.

## Private links and `helm forward`
- **Prove:** `test/browser/private-spin-e2e` runs the real sign-in, share
  gate, daemon tunnels and plain Vite behind a private TLS gateway. It
  checks default localhost, IPv4, IPv6 and all-address listeners, exact
  return URLs, existing sign-in, live reload and automatic recovery.
- **Sign-in:** the Helm home keeps the destination in this tab until it
  posts a one-use pass to the spin. Each spin gets its own host-only,
  secure cookie; never broaden Helm's session cookie to all subdomains.
- **Traps:** pairing links replace the URL fragment. Preserve the pending
  destination across that change and reloads, and carry it when opening
  local Helm. A newly created name must refresh the hub's share list even
  when another spin just warmed its cache.
- **App hosts:** Helm sends `Host: localhost:<port>` for HTTP and
  WebSockets, preserving the visitor's host in `X-Forwarded-Host`.
  `--preserve-host` opts out for apps that need the original host.
- **Tests:** `test/share-private`, `share-links`, `loopback`, `tunnel-ports`;
  `test/browser/private-links`, `private-spin-e2e`.
