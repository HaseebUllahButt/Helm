# Chats and the composer

Start with a quick chat on the Fake agent (see [README](README.md)).

## Send and reply
- **Prove (driven 2026-10-15):**
  `$V click "Ask anything"; $V type "hello from me"; $V click send; $V wait "done."`
- **Proof:** `text` shows "hello from me", a time, and "working on it done.";
  the header title changes from "Quick chat".
- **Traps:** the title is made from your words and may drop one ("hello from
  fmap" became "from fmap"). The model chip shows real Devin model names even
  for the fake agent.
- **Tests:** `test/browser/chat-cycle`, `send-v2`, `send-entry-points`,
  `failed-send`, `composer-card`; `test/message-delivery`, `user-message`,
  `stream`, `session-driver`.

## Queue a message while the agent works
- **Prove (driven):** fake-ask keeps the turn open.
  ```sh
  $V click "Ask anything"; $V type "first"; $V click send; $V wait "TOOL APPROVAL"
  $V click "Decide above"; $V type "second"; $V click send; $V wait "1 waiting"
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
- **Storage rule:** append new events to history files. Replace old history
  with a rename. Readers keep byte positions between pages and search updates.
- **Prove selection copy (driven 2026-10-17):** fake chat at 390×844 with
  clipboard permission granted; blur the composer, select `.chat .md p`
  with a Range (no pointer events). After 450 ms
  `navigator.clipboard.readText()` holds "working on it done.", the
  selection stays, and "Copied" shows. At 1280×800 a real double-click on a
  word copies it.
- **Traps:** iPhone handles and Safari permissions still need a device.
- **Tests:** `test/browser/activity-fold`, `chat-fold`,
  `history-pagination`, `transcript-performance`, `copy-selection`,
  `highlight-performance`, `markdown-loading`.
