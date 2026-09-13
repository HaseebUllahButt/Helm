#!/usr/bin/env bash
#
# What the auth rewrite could regress, exercised against two real hubs:
# a device surviving a restart, a machine accepting a device it has never
# seen, a forged token, and a revocation crossing the network.
#
#   bash test/network.sh
#
# End-to-end: does a device survive a restart, and does it work on a machine
# that has never seen it?
set -u
cd "$(dirname "$0")/.."
S="${TMPDIR:-/tmp}/helm-test-$$"
rm -rf "$S"; mkdir -p "$S/A" "$S/B"
APID=
BPID=
cleanup() {
  [ -z "$APID" ] || kill "$APID" 2>/dev/null || true
  [ -z "$BPID" ] || kill "$BPID" 2>/dev/null || true
  rm -rf "$S"
}
fail() { echo "  FAIL  $*"; exit 1; }
trap cleanup EXIT

A_ENV="HELM_DIR=$S/A HELM_DB=$S/A/hub.sqlite NAME=laptop"
B_ENV="HELM_DIR=$S/B HELM_DB=$S/B/hub.sqlite NAME=vm"

start_a() { env HELM_DIR=$S/A HELM_DB=$S/A/hub.sqlite NAME=laptop \
  node ./test/hub.mjs 8801 new > "$S/a.log" 2>&1 & echo $!; }
start_b() { env HELM_DIR=$S/B HELM_DB=$S/B/hub.sqlite NAME=vm \
  node ./test/hub.mjs 8802 > "$S/b.log" 2>&1 & echo $!; }

wait_up() { for i in $(seq 1 50); do curl -sf "$1/api/health" >/dev/null && return 0; sleep 0.1; done; return 1; }

echo "=== 1. machine A starts a network ==="
APID=$(start_a); wait_up http://127.0.0.1:8801 || { cat "$S/a.log"; exit 1; }
HEADERS=$(curl -sD - -o /dev/null http://127.0.0.1:8801/)
printf '%s' "$HEADERS" | grep -qi '^content-security-policy:' \
  || fail 'web app has no content security policy'
printf '%s' "$HEADERS" | grep -qi '^x-content-type-options: nosniff' \
  || fail 'web app can MIME-sniff content'
env HELM_DIR=$S/A node -e '
import("@helm/protocol/network").then((N) => {
  const net = N.loadNetwork();
  N.describeSelf(net, { endpoints: ["http://127.0.0.1:8801"] });
});'
PAIR_OUTPUT=$(env HELM_DIR=$S/A node packages/connect/bin/helm.js link)
PAIR_URL=$(printf '%s\n' "$PAIR_OUTPUT" | grep -o 'http[^ ]*#pair=[^ ]*' | head -1)
PASS_A=$(python3 -c 'import sys,urllib.parse;print(urllib.parse.parse_qs(urllib.parse.urlparse(sys.argv[1]).fragment)["pair"][0])' "$PAIR_URL")
echo "pairing link: $PAIR_URL"

echo
echo "=== 2. a phone signs in to A ==="
LOGIN=$(curl -sf -X POST http://127.0.0.1:8801/api/auth/login \
  -H 'content-type: application/json' -d "{\"password\":\"$PASS_A\",\"label\":\"phone\"}")
TOKEN=$(echo "$LOGIN" | python3 -c 'import json,sys;print(json.load(sys.stdin)["token"])')
DEVID=$(echo "$LOGIN" | python3 -c 'import json,sys;print(json.load(sys.stdin)["deviceId"])')
echo "device $DEVID signed in"
curl -sf http://127.0.0.1:8801/api/network -H "authorization: Bearer $TOKEN" \
  | python3 -c 'import json,sys;d=json.load(sys.stdin);print("  A sees",len(d["machines"]),"machine(s),",len(d["devices"]),"device(s)")'

echo
echo "=== 3. RESTART machine A (this is what used to sign the phone out) ==="
kill $APID 2>/dev/null; wait $APID 2>/dev/null
APID=$(start_a); wait_up http://127.0.0.1:8801 || { cat "$S/a.log"; exit 1; }
CODE=$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:8801/api/network -H "authorization: Bearer $TOKEN")
[ "$CODE" = "200" ] && echo "  PASS  phone still signed in after restart (HTTP $CODE)" \
                    || fail "phone was signed out (HTTP $CODE)"

echo
echo "=== 4. machine B joins the network ==="
ADD_OUTPUT=$(env HELM_DIR=$S/A node packages/connect/bin/helm.js add)
INVITE=$(printf '%s\n' "$ADD_OUTPUT" | grep -o '[A-Z2-9]\{4\}-[A-Z2-9]\{4\}' | head -1)
echo "invite: $INVITE"
env HELM_DIR=$S/B node -e '
import("@helm/protocol/network").then(async (N) => {
  const r = await fetch("http://127.0.0.1:8801/api/join", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ code: process.argv[1], name: "vm" }),
  });
  const b = await r.json();
  if (!r.ok) { console.error("join failed:", b); process.exit(1); }
  N.joinNetwork({ id: b.id, key: b.key, name: "vm", port: 8802,
                  machines: b.machines, devices: b.devices, revoked: b.revoked });
  console.log("  B joined; knows", Object.keys(b.devices).length, "device(s) from the roster");
});' "$INVITE"
BPID=$(start_b); wait_up http://127.0.0.1:8802 || { cat "$S/b.log"; exit 1; }

echo
echo "=== 5. the SAME phone token, against B ==="
CODE=$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:8802/api/network -H "authorization: Bearer $TOKEN")
[ "$CODE" = "200" ] && echo "  PASS  B accepts the phone (HTTP $CODE)" \
                    || fail "B rejected the phone (HTTP $CODE)"

echo
echo "=== 6. a phone that was NEVER in this network ==="
FORGED=$(env HELM_DIR=$S/A node -e '
import("@helm/protocol/identity").then((I) => {
  const k = I.newNetworkKey();
  console.log(I.mintToken(k, { net: "whatever", sub: "attacker", role: "device" }));
});')
CODE=$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:8802/api/network -H "authorization: Bearer $FORGED")
[ "$CODE" = "401" ] && echo "  PASS  forged token rejected (HTTP $CODE)" \
                    || fail "forged token accepted (HTTP $CODE)"

echo
echo "=== 7. remove the phone from B; does A honour it? ==="
curl -sf -X DELETE "http://127.0.0.1:8802/api/devices/$DEVID" -H "authorization: Bearer $TOKEN" >/dev/null
CODE=$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:8802/api/network -H "authorization: Bearer $TOKEN")
echo "  B now: HTTP $CODE (expect 401)"
# Gossip B's roster to A, the way a daemon link does.
env HELM_DIR=$S/B node -e '
import("@helm/protocol/network").then(async (N) => {
  const net = N.loadNetwork();
  const tok = N.mintToken ? null : null;
  const { machineToken } = N;
  const r = await fetch("http://127.0.0.1:8801/api/roster", {
    method: "POST",
    headers: { "content-type": "application/json",
               authorization: "Bearer " + machineToken(net) },
    body: JSON.stringify(N.roster(net)),
  });
  console.log("  gossiped B -> A:", r.status);
});'
CODE=$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:8801/api/network -H "authorization: Bearer $TOKEN")
[ "$CODE" = "401" ] && echo "  PASS  A honours the removal (HTTP $CODE)" \
                    || fail "A still accepts the removed phone (HTTP $CODE)"

echo
echo "=== 8. a second always-on VM joins the mesh with 'helm setup --join' ==="
mkdir -p "$S/C"
ADD2=$(env HELM_DIR=$S/A node packages/connect/bin/helm.js add)
INVITE2=$(printf '%s\n' "$ADD2" | grep -o '[A-Z2-9]\{4\}-[A-Z2-9]\{4\}' | head -1)
# HELM_NO_SERVICE=1 stops before the systemd/HTTPS steps; an explicit https
# home skips Caddy. What we are checking is that setup --join lands this VM in
# A's existing network rather than founding its own.
env HELM_DIR=$S/C HELM_SSH_DIR=$S/C/ssh HELM_NO_SERVICE=1 \
  node packages/connect/bin/helm.js setup --join "$INVITE2" \
  --at http://127.0.0.1:8801 https://vm-c.example >/dev/null 2>&1
A_NET=$(env HELM_DIR=$S/A node -e 'import("@helm/protocol/network").then(N=>console.log(N.loadNetwork().id))')
C_NET=$(env HELM_DIR=$S/C node -e 'import("@helm/protocol/network").then(N=>{const n=N.loadNetwork();console.log(n?n.id:"none")})')
[ -n "$A_NET" ] && [ "$A_NET" = "$C_NET" ] \
  && echo "  PASS  second VM joined the same mesh ($C_NET)" \
  || fail "second VM did not join A's mesh (A=$A_NET C=$C_NET)"

echo
echo "done."
