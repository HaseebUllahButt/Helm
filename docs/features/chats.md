# Chats and the composer

Start with a quick chat on the Fake agent (see [README](README.md)).

## Send and reply
- **Prove (driven 2026-10-15):**
  `$V click "Ask anything"; $V type "hello from me"; $V click send; $V wait "done."`
- **Proof:** `text` shows "hello from me", a time, and "working on it done.";
  the header title changes from "Quick chat".
- **Traps:** the title is made from your words and may drop one ("hello from
  fmap" became "from fmap"). The model chip shows real Devin model names even
  for the fake agent. Streamed replies must not redraw the message editor;
  approval cards and settings still update while a draft stays in the box.
- **Errors (driven 2026-10-24):** make each `session.deliver` request return
  a timeout in the private browser. After two minutes, expect "Send not
  confirmed", a plain timeout message, and Retry send. Restore replies and
  select Retry send. Expect one reply and the original message ID on every
  attempt. Check `errors` and inspect `shot` at phone size.
- **Rule:** app errors use `apps/web/src/errors.ts`. Keep clear, short messages.
  Put technical text behind Details on failed tasks. Log each distinct error once.
  Retry an unconfirmed send with its original
  ID, text, images and chat references.
- **Tests:** `test/web-errors`; `test/browser/chat-cycle`, `send-v2`, `send-entry-points`,
  `failed-send`, `composer-card`, `composer-streaming`; `test/message-delivery`, `user-message`,
  `stream`, `session-driver`.

## Queue a message while the agent works
- **Prove (driven 2026-10-23):** fake-ask keeps the turn open.
  ```sh
  $V click "Ask anything"; $V type "first"; $V click send; $V wait "TOOL APPROVAL"
  $V click "Message Devin"; $V type "second"; $V click send; $V wait "1 waiting"
  $V restart                            # the first approval and second message stay
  $V click Approve; $V wait "TOOL APPROVAL"   # "second" was delivered and asks again
  ```
- **Traps:** each CLI reads a mid-reply message at a different moment
  (Codex after its next step, Claude after its current tools).
- **Tests:** `test/dispatch-queue`, `input-delivery`, `peer-input`,
  `upgrade-input`; `test/browser/composer-card`.

## Stop a reply
- **Rule:** with a message of yours waiting (queued, or handed to the CLI
  mid-reply), Stop ends only the reply and that message goes next; with
  nothing waiting it is a full stop. Codex reads a handed message within
  seconds, so its handed case keeps the full stop (no
  `dropsHandedOnInterrupt`) rather than risk sending it twice. While an
  approval waits there is no stop button; Decline ends the turn.
- **Prove the waiting case (driven 2026-10-18, real Claude):** ask for
  `python3 -c 'import time; time.sleep(45)'` in the foreground, send "Reply
  with only the word LEMON." while it runs, click "stop the agent". The log
  shows LEMON `turn.deliver`, the long turn `interrupted`, then LEMON as its
  own turn, answered once.
- **Prove the button (half driven):** the fake reply is too fast for two
  commands, so click inside one `eval`:
  ```sh
  $V click "Ask anything"; $V type "stop me"
  $V eval "(async()=>{document.querySelector('button.send').click();for(let i=0;i<80;i++){const s=document.querySelector('button.stop');if(s){s.click();return 'clicked'}await new Promise(r=>setTimeout(r,25))}return 'none'})()"
  ```
  Proof: "stopped" under the reply. Decline on fake-ask shows "You stopped
  this task." (driven).
- **Traps:** the fake agent ignores the stop signal, so a stop on fake-ask
  proves nothing.
- **Tests:** `test/browser/turn-pulse`, `chat-cycle`; `test/kick`,
  `restart-delivery`.

## Permission mode, model and thinking
- **Reach:** the chips under the box; Shift+Tab next mode (bypass included),
  Ctrl/⌘+Shift+M next model, Ctrl/⌘+Shift+Y next thinking level, Ctrl/⌘+/
  lists every key.
- **Rules:** a chip shows the new value at once with "saving…"; a failed
  save restores the accepted value. A model switch warns about cache cost
  only when the CLI says the cache is warm (Claude 2.1.300+ prices it in its
  PreModelSwitch hook; others get Helm's estimate). Helm answers Claude's
  own "Switch model?" question so it never hides behind the chat. A
  thinking change warns only when the CLI says it rewrites the cache.
- **Prove (Shift+Tab driven 2026-10-17):** fake chat at 1280 wide,
  `$V key Shift+Tab` three times: the chip reads edit, read, then yolo
  (`$V eval` the `.slab` buttons' aria-labels).
- **Prove the warning (driven 2026-10-17):** a private profile with engine
  `claude`, the real `claude` command and `ANTHROPIC_BASE_URL` at a local
  stand-in API that reports a big `cache_creation_input_tokens`. Say hello,
  pick another model: "Claude says this conversation's prompt cache is still
  warm" with Claude's price.
- **Tests:** `test/browser/settings-latency` (held save), `chat-shortcuts`,
  `global-keys`, `effort-default`, `slash-model-context`; `test/chat-keys`,
  `modes`, `session-settings`, `recache`, `driver-claude`,
  `native-claude-chat`.

## @ chats and / commands
- **Not yet driven:** `$V type "@"` should list up to three chats; `/` lists
  commands. The CLIs' own built-in slash commands are not listed.
- **Tests:** `test/commands`, `commands-devin`, `slash-title`,
  `hidden-context`.

## Long chats: folds, copy, selection
- **Latest first:** opening a chat or returning to it reads its newest window.
  Saved text can appear first when offline. Missed live events do not replay.
  Older replies load with the earlier-history control.
- **Live reading:** a hidden chat releases its live view. Only devices with
  an open view receive its text. Text redraws before repeated tool updates;
  events keep their original order. Repeated tool output sends its newest
  value within each short batch. Full history stays on the machine.
- **Prove latest first (driven 2026-10-23 with the Rust reader):** close a private chat, add many replies to its private
  history, restart the private daemon, and reopen the chat. Check that the
  latest answer appears. Load earlier replies and check that they appear.
  Send another message and check that the live answer arrives once.
- **Storage rule:** append new events to history files. Replace old history
  with a rename. Readers keep byte positions between pages and search updates.
  Rust scans saved record positions when built; JavaScript remains available.
  See [the reader boundary and checks](../rust-log-reader.md).
- **Prove selection copy (driven 2026-10-17):** fake chat at 390×844 with
  clipboard permission granted; blur the composer, select `.chat .md p`
  with a Range (no pointer events). After 450 ms
  `navigator.clipboard.readText()` holds "working on it done.", the
  selection stays, and "Copied" shows. At 1280×800 a real double-click on a
  word copies it.
- **Traps:** iPhone handles and Safari permissions still need a device.
- **Tests:** `test/browser/activity-fold`, `chat-fold`,
  `history-pagination`, `transcript-performance`, `copy-selection`,
  `highlight-performance`, `markdown-loading`, `latest-first`, `chat-sync`;
  `test/event-stream`, `stream-routing`.
