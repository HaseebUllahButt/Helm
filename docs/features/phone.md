# Phone requests (`helm phone`)

An agent asks the owner for what only the phone has: an answer, a photo,
the location, or a one-time sign-in code from a text message.

## Rules
- **Commands:** `helm phone ask "<q>" [--choice <a>]...`, `photo ["<why>"]`,
  `location ["<why>"]`, `code ["<site>"]`; `--why`, `--timeout <min>`
  (default 30, up to 24 h), `--json`. `helm phone list | cancel <id|all>`
  show and close open requests. Exit codes: 0 answered, 1 refused, 2 wrong
  use, 3 no answer in time, 130 closed.
- **Cards:** Helm's own cards (`phone.js`, `Sessions.showHelmAsk`), like
  `helm sudo`. So the chat reads as waiting, "Needs you" says what it wants,
  the waiting box shows the full card (`PhoneSheet` variant `island`), and a
  notification goes to every controller. Each card names the chat that asks
  ("Asked by <chat>") and the why. Every card has Refuse.
- **Answers do not go through `session.answer`:** that one is kept in
  browser storage until it arrives, and a photo or a code must not be. The
  card calls `phone.give` and `phone.photo` on the chat's machine
  (`phone.envId` on the card). A Refuse or a typed answer through
  `session.answer` still works (`PhoneRequests.answer`).
- **Photo:** made smaller like a message picture (`prepareImage`), sent in
  512 KiB pieces, saved in `~/.helm/uploads/<chat>/`, so deleting the chat
  deletes it. A photo the browser cannot read (HEIC outside Safari) goes
  as it is, up to 20 MB.
- **Location:** one `getCurrentPosition` per tap. It needs a secure page
  (https or localhost).
- **Code:** a web app cannot read text messages. The box has
  `autocomplete="one-time-code"` (iPhone offers the code above the
  keyboard), a Paste button, and the installed app is a share target on
  Android (`share_target` in the manifest, `/?share-text=`): share the
  message to Helm and the open code card fills in. `findCode` (same in
  `phone.js` and `phoneShare.ts`) takes the code out of the message.
- **Restart:** open requests are in `~/.helm/phone/requests.json`. The card
  comes back, and `helm phone` asks again with the same id. An answer stays
  on disk only until the agent reads it.
- **Endings:** deleting the chat, or Stop after the request began, closes
  it. A card whose `helm phone` stopped asking for 3 min closes.

## Prove (driven 2026-11-19)
```sh
$V rpc session.start '{"quick":true,"profileId":"fake-slow","title":"Fix the login"}'
H="env -u HELM_NATIVE_SESSION HELM_SESSION_ID=<chat> HELM_DIR=/tmp/helm-verify-<you>/helm node packages/connect/bin/helm.js"
$H phone ask "Which plan?" --choice Small --choice Big &   # click "Big": prints Big
$H phone photo "Show the error" &; $V restart                # the card comes back
$V eval "<make a canvas File, set it on .sheet.phone input[type=file]:not([capture]), dispatch change>"
$V click "Send photo"                                        # prints the .jpg path
$H phone code GitHub &
$V eval "location.assign('/?share-text='+encodeURIComponent('Your code is 482-913'))"
$V click "Fix the login"; $V click "Send code"               # prints 482913
$H phone location &
$V eval "navigator.geolocation.getCurrentPosition=(ok)=>ok({coords:{latitude:31.52,longitude:74.35,accuracy:14}})"
$V click "Send my location"
```

## Traps
- The hidden browser has no camera, no GPS and no share sheet: the steps
  above stand in for them. A real phone was not driven.
- An agent runs as the owner's user and could call `phone.give` itself.
  The card is a way to ask, not a wall against a hostile agent.
- Agent tools stop a command after a few minutes. Agents must give
  `helm phone` a long time limit or run it in the background.

## Tests
`test/phone`, `phone-cli`.
