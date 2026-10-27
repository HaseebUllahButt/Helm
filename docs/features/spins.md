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
  $V key Control+Shift+s; $V click "Spins"; $V text
  $V click Stop; $V rpc share.list                    # "shares": []
  ```
- **Proof:** "mytest · port 5173 · open to anyone with the link · ends in 2h
  59m", then after Stop "Nothing shared from verify-<you>.".
- **Traps:** start the app before sharing it; Helm checks both loopback
  addresses and refuses a closed port. The private copy has no VM, so `url` is null and the page says
  "No machine in your network has a public address yet". A real link needs
  the real network; use `--private` or `--password` for anything not meant
  for the public, and stop it when done. `--keep` only when the owner asks.
  A link made from a chat (`HELM_SESSION_ID`) on its own machine notes that
  chat; deleting the chat stops it. Kept links never belong to a chat.
- **Tests:** `test/share-links`, `share-private`, `share-expiry`,
  `share-flow`, `share-recovery`, `share-input`, `tunnel-flow`, `tunnel-ports`, `caddy`, `proxy`;
  `test/browser/private-links`.

## Private links
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
- **Access checks:** a known link keeps its decision for at most five seconds.
  The next request checks the source machine before it uses an old tunnel.
  A slow unrelated machine does not delay that check. Old discovery replies
  cannot replace newer source replies. Unknown names share one discovery per
  second; a new name can wait up to one second on its first visit.
- **Names:** app and CLI creation check other online machines. Offline
  machines do not reserve names. If two machines later report the same name,
  the hub refuses both links with a clear conflict page. Warm links find a
  later conflict through background discovery. This is not a central name
  reservation, so simultaneous creates can still conflict.
- **Sign-in traffic:** form bodies have a 4 KiB byte limit and a ten-second
  deadline. Attempts count before the body arrives. Only the local HTTPS
  proxy can supply a visitor address. These checks do not stop network floods.
- **App hosts:** Helm sends `Host: localhost:<port>` for HTTP and
  WebSockets. The link host goes nowhere else: X-Forwarded-Host, Forwarded
  and similar headers are dropped, and Origin/Referer on the link become
  `http://localhost:<port>`. Dev servers (Express, Vite, webpack) check all
  of these. `--preserve-host` sends the link host in Host and
  X-Forwarded-Host for apps that need it.
- **Tests:** `test/share-private`, `share-links`, `loopback`, `tunnel-ports`;
  `test/browser/private-links`, `private-spin-e2e`.

## `helm forward`: a dev server on the owner's machine
- **Use:** the agent runs `helm forward <port>` on the machine with the app
  and gives the owner only the `http://localhost:<port>` link it prints.
  No --to: Helm picks the machine where the owner used the Helm app last
  (`protocol/owner-seen.js`: the hub notes person-only RPCs from a device
  served over loopback; agents and Caddy visits do not count).
  `helm share <port> --to <machine>` is the same command.
- **Design:** two halves with one id in `~/.helm/forwards.json`. `out` on
  the app's machine allows that port for tunnels; `in` on the owner's
  machine is a listener the Helm service owns. No Spin is made. Each
  connection opens its own hub tunnel, so app restarts and network drops
  heal on the next load. Failures give a 502 page naming the machine, the
  port and the reason (`x-helm-forward: app|refused|unreachable`).
- **Lifetime:** 3 hours unless --keep or --for. A restart reopens the
  same local port. A stop on either machine removes its half and tells the
  other; an away machine is told when it is back (`pending`). A refused
  `in` half asks the other machine and goes if its half is gone.
- **Tests:** `test/forward-service`, `share-private`, `tunnel-ports`.
