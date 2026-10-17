# Chats and the composer

`V="node scripts/verify-helm.mjs --name <you>"`, then `$V up && $V open` and a
quick chat with the Fake agent (see [README](README.md)).

## Send a message, see the reply
- **Sees:** your message as a bubble with the time, then the agent's reply.
  The chat gets a title from your words.
- **Reach:** the box at the bottom ("Ask anything, …"), then the round send
  button. On a keyboard, Enter sends and Shift+Enter makes a new line; on a
  phone, Enter makes a new line.
- **CLI:** `helm say <chat-id> <text>`; `helm chat <account> [-- text]`
  shares one live chat between a terminal and the app.
- **Prove (driven 2026-10-15):**
  ```sh
  $V click "Ask anything"; $V type "hello from me"; $V click send; $V wait "done."
  ```
- **Proof:** `text` shows "hello from me", a time, and "working on it done.".
  The header title changes from "Quick chat".
- **Traps:** the title is made from your words and may drop a word ("hello
  from fmap" became "from fmap"). The model chip shows real Devin model names
  even for the fake agent.
- **Tests:** `test/browser/chat-cycle`, `send-v2`, `send-entry-points`,
  `failed-send`, `composer-card`; `test/message-delivery`, `user-message`,
  `stream`, `session-driver`.

## Queue a message while the agent works
- **Sees:** "1 waiting", your message, "After current response", with
  **Edit** and **Send now**. It goes by itself when the reply ends.
- **Reach:** type and send while a reply runs.
- **Prove (driven):** use "fake-ask" so the turn stays open.
  ```sh
  $V click "Ask anything"; $V type "first"; $V click send; $V wait "TOOL APPROVAL"
  $V click "Decide above"; $V type "second"; $V click send; $V wait "1 waiting"
  $V click Approve; $V wait "TOOL APPROVAL"   # "second" was delivered and asks again
  ```
- **Proof:** "1 waiting" and "After current response", then "second" shows
  as a normal bubble after the first reply ends.
- **Traps:** each CLI reads a mid-reply message at a different moment
  (Codex after its next step, Claude after its current tools).
- **Tests:** `test/dispatch-queue`, `input-delivery`, `peer-input`,
  `upgrade-input`; `test/browser/composer-card`.

## Stop a reply
- **Sees:** a square stop button replaces send while the agent works. After
  stopping: "Task stopped · You stopped this task." and **Continue**.
- **Reach:** the stop button ("stop the agent"). While an approval waits there
  is no stop button; **Decline** ends the turn instead.
- **Prove (half driven):** the plain fake reply takes 0.8 s, too fast for two
  commands, so click inside one `eval`:
  ```sh
  $V click "Ask anything"; $V type "stop me"
  $V eval "(async()=>{document.querySelector('button.send').click();for(let i=0;i<80;i++){const s=document.querySelector('button.stop');if(s){s.click();return 'clicked'}await new Promise(r=>setTimeout(r,25))}return 'none'})()"
  ```
- **Proof:** "stopped" under the reply. Decline on "fake-ask" shows "Task
  stopped" and "You stopped this task." (driven).
- **Traps:** the fake agent ignores the stop signal and carries on to its
  approval, so a stop on "fake-ask" is not proof. Prove Stop with Decline, or
  with a real account in a chat you made.
- **Tests:** `test/browser/turn-pulse`, `chat-cycle`; `test/kick`,
  `restart-delivery`.

## Permission mode, model and thinking
- **Sees:** chips under the box: model ("model: …") and permissions
  (ask · edit · auto · yolo for Claude; ask · edit · yolo · read for Codex).
  A riskier mode takes two taps and colours the box.
- **Reach:** tap a chip. Keys: Shift+Tab next mode (every mode, bypass
  included, then round again), Ctrl/⌘+Shift+M next
  model (favourites first), Ctrl/⌘+Shift+L next thinking level. "?" lists
  every key.
- **Cache warning:** a running Claude (2.1.300 or newer) prices a model
  switch itself in its PreModelSwitch hook (`prompt_cache_warm`,
  `context_tokens`, `estimated_cache_write_usd`); Helm asks only when Claude
  says the cache is warm and big, with Claude's price, and never when it is
  cold. Terminal Claude chats get the same through Helm's hooks, and Helm
  answers Claude's own "Switch model?" question so it never sits hidden
  behind the chat. Codex, ACP agents and a Claude that is not running keep
  Helm's estimate, priced at the size the CLI reports now. Changing
  thinking level asks only when the CLI itself says it rewrites the cache:
  Claude sends `per_turn_effort_active` at start-up and
  `per_turn_effort_changed` if that stops (Opus 5.5 on 2.1.301 says true,
  checked 2026-10-16). A CLI that says nothing gets no warning.
- **Prove (Shift+Tab driven 2026-10-17):** in a fake chat at 1280 wide,
  `$V key Shift+Tab` three times; the chip reads edit, read, then yolo
  again (`$V eval` the `.slab` buttons' aria-labels).
- **Prove the model warning:** add a profile to the private copy with
  engine `claude`, the real `claude` command, and `ANTHROPIC_BASE_URL`
  pointing at a small local stand-in API whose replies report a big
  `cache_creation_input_tokens`; say hello, then pick another model: the
  dialog reads "Claude says this conversation's prompt cache is still
  warm" with Claude's price (driven 2026-10-17).
- **Tests:** `test/browser/chat-shortcuts`, `global-keys`, `effort-default`,
  `slash-model-context`; `test/chat-keys`, `modes`, `session-settings`,
  `recache`, `driver-claude`, `native-claude-chat`.

## @ chats and / commands
- **Sees:** typing `@` lists up to three other chats to add as context;
  `/` lists what Helm can run plus your own command files.
- **Prove:** steps not yet driven. `$V type "@"`, then `text` should list chat
  titles; `$V type "/"` should list commands.
- **Traps:** the CLIs' own built-in slash commands are not listed.
- **Tests:** `test/commands`, `commands-devin`, `slash-title`,
  `hidden-context`.

## Reading a long chat
- **Sees:** work between two agent messages folds into one line ("Read 1
  file · Ran 2 commands"); "working 12s · 97 tok/s" while it runs (an
  estimate); a copy button under each answer; up/down arrows that jump
  between your own messages. Selecting text copies it: with the mouse on
  letting go, on a phone once the selection stops moving, with "Copied"
  shown low on the screen. Safari only lets a tap write the clipboard, so
  there it is copied on the next touch.
- **Reach:** "Copy answer", "previous message of yours", "next message of
  yours" buttons.
- **Prove:** steps not yet driven beyond seeing these buttons in a fake chat.
  Phone copy (driven 2026-10-16): verify clicks are mouse clicks, so press
  with a touch first, then select the reply in `eval`, after swapping
  `navigator.clipboard.write`/`writeText` for ones that record:
  `n.dispatchEvent(new PointerEvent('pointerdown',{pointerType:'touch',bubbles:true}))`,
  then a Range over `.md p`. About half a second later the text is
  recorded and `.selection-copied` says "Copied".
- **Tests:** `test/browser/activity-fold`, `chat-fold`,
  `history-pagination`, `transcript-performance`, `copy-selection`.
