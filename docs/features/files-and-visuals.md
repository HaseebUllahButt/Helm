# Files, images, voice and visuals

## Images and files in a message
- **Limits:** 8 images, 8 MB each, 24 MB a message; iPhone HEIC works.
- **Prove the refusal (driven 2026-10-15):** paste an 8×8 picture into a
  plain fake chat:
  ```sh
  $V eval "(async()=>{const c=document.createElement('canvas');c.width=c.height=8;c.getContext('2d').fillRect(0,0,8,8);const b=await new Promise(r=>c.toBlob(r,'image/png'));const d=new DataTransfer();d.items.add(new File([b],'dot.png',{type:'image/png'}));const t=document.querySelector('textarea[data-composer]');t.focus();t.dispatchEvent(new ClipboardEvent('paste',{clipboardData:d,bubbles:true,cancelable:true}))})()"
  ```
  Proof: "Devin cannot be sent images in this session.".
- **Prove a sent picture (driven 2026-10-15):** with **fake-pics**,
  `$V upload a.jpg b.jpg`, type, send. The pictures show above the words,
  and the "[Image #1]" labels that open a message are hidden. A text file
  shows as "[File: note.txt]".
- **Tests:** `test/browser/image-paste`; `test/paste-store`,
  `retain-assets`.

## Canvas (notes and docs beside the chat)
- **Reach:** the canvas button in a chat's header, or Ctrl/⌘ Shift D. A wide
  screen gets a third column (shares the browser panel's slot, one at a
  time); a phone gets a full-screen sheet. Open state and file are kept per
  chat on the device. A file name in a turn's "changed files" opens it there.
- **Rules:** Git projects only (it lists with `git.files`). Saves go through
  `git.write` with the hash the file was read at: a file the agent changed
  since is never overwritten silently; the owner picks "Use the new file" or
  "Save mine over it". Secrets and `.git/` are never written; a new file
  under a link that leads out of the repo is refused before any folder is
  made. Unsaved edits live in memory while the app is open.
- **Prove (driven 2026-10-21):** make a git repo in the copy's work folder,
  `$V rpc session.start '{"cwd":"<repo>","profileId":"fake"}'`, open it at
  `size 1600 900`, click "Canvas", open a `.md`, Edit, type, Ctrl+S; then
  append to the file from the shell (the page follows within 2 s) and again
  while editing (the clash card shows).
- **Traps:** `wait` does not read the edit box; check it with `eval`.

## Voice
- **Decision:** the device calls Groq itself. It asks a machine once for the
  key (`voice.direct`), keeps it in the browser (`helm.voice.direct`), and
  posts the recording straight to Groq. A new key saved in Settings drops
  the kept one; a refused key is fetched again once. Only when the direct
  call fails does a machine transcribe (`voice.transcribe`, logging
  `voice: <size>, Groq answered in <ms>`). A lost device keeps the key until
  a new one is saved: the owner chose speed over that (2026-10-16).
- **Prove (driven 2026-10-16):** `cp ~/.config/groq-api-key
  /tmp/helm-verify-<you>/helm/`, open a chat, `eval` a fake microphone (an
  `AudioContext` oscillator into `createMediaStreamDestination()`, returned
  from `navigator.mediaDevices.getUserMedia`) and a `window.fetch` wrapper.
  Click "speak a prompt", wait, click "stop recording".
- **Proof:** one POST to api.groq.com (200) and no `voice:` line in
  `$V logs`. A tone gives no words.
- **Tests:** `test/voice`, `voice-key`.

## Visuals in a chat
- **Prove (driven):**
  ```sh
  echo '<div style="padding:20px">my visual ok</div>' > /tmp/v.html
  $H render /tmp/v.html --title "my visual" --session <chat-id>   # $H: see README
  # then open that chat (Home → Settled → its title)
  $V wait "my visual"; $V shot /tmp/vis.png
  ```
- **Proof:** "my visual ok" in the chat; "Expand my visual" opens it with
  Source / Save.
- **Traps:** without `HELM_DIR` and `--session`, `render` posts into the
  owner's real chat.
- **Tests:** `test/visual-replies`; `test/browser/visual-replies`. Design:
  [`docs/visual-replies.md`](../visual-replies.md).

## Markdown, code and diffs in replies
- **Not yet driven;** the fake agent replies in plain text.
- **Tests:** `test/browser/markdown-loading`, `inline-diff`,
  `copy-selection`.
