# Files, images, voice and visuals

## Images and files in a message
- **Sees:** the clip button ("Attach files or images"), paste or drag. Up to
  8 images, 8 MB each, 24 MB a message; iPhone HEIC works. Each shows as a
  chip with a remove button ("remove <name>"). Big pastes fold into one chip
  and go whole on send. If the CLI cannot take images: "<CLI> cannot be
  sent images in this session."
- **Prove (refusal driven 2026-10-15; a real send not yet driven):** paste
  an 8×8 picture with `eval`:
  ```sh
  $V eval "(async()=>{const c=document.createElement('canvas');c.width=c.height=8;c.getContext('2d').fillRect(0,0,8,8);const b=await new Promise(r=>c.toBlob(r,'image/png'));const d=new DataTransfer();d.items.add(new File([b],'dot.png',{type:'image/png'}));const t=document.querySelector('textarea[data-composer]');t.focus();t.dispatchEvent(new ClipboardEvent('paste',{clipboardData:d,bubbles:true,cancelable:true}))})()"
  $V shot /tmp/img.png
  ```
- **Proof:** with the fake agent: the red line "Devin cannot be sent images
  in this session.". With a CLI that takes images: a "remove dot.png" chip.
- **Sent (driven 2026-10-15):** pick **fake-pics** (the fake agent that
  takes pictures), `$V upload a.jpg b.jpg`, type, send. The message shows
  the pictures two to a row above the words; the "[Image #1] [Image #2]"
  labels that open a message are hidden, labels inside the words stay.
  Tapping a picture opens it big.
- **Traps:** the plain fake agent never takes images; fake-pics does. Other files attach with
  `$V upload <file>` (driven: a text file shows as "[File: note.txt]"). Images
  survive a restart.
- **Tests:** `test/browser/image-paste`; `test/paste-store`,
  `retain-assets`.

## Voice
- **Sees:** a mic button ("speak a prompt"); while recording it shows the
  seconds. Ctrl+Shift+Space dictates. Silent recordings are not sent.
  Settings → Dictation key → **Change**.
- **CLI:** `helm dictate [--to <chat-id>]`.
- **Where it goes:** the device calls Groq itself. It asks a machine once
  for the key (`voice.direct`), keeps it (`helm.voice.direct` in the
  browser), and posts the recording straight to Groq at 32 kbps. Saving a
  new key in Settings drops the kept one; a refused key is fetched again
  once. Only when the direct call fails does a machine transcribe
  (`voice.transcribe`, quickest machine first, logging `voice: <size>,
  Groq answered in <ms>`).
- **Prove (driven 2026-10-16):** copy a Groq key to the private copy
  (`cp ~/.config/groq-api-key /tmp/helm-verify-<you>/helm/`), open a chat,
  then `eval` a fake microphone: an `AudioContext` oscillator into
  `createMediaStreamDestination()`, returned from
  `navigator.mediaDevices.getUserMedia`. Click "speak a prompt", wait, click
  "stop recording". Wrap `window.fetch` first to see the call: one POST to
  api.groq.com (200, 1.9 s for a tone) and no `voice:` line in `$V logs`,
  since no machine transcribed. A tone gives no words, so the box stays empty.
- **Traps:** a lost device keeps the Groq key until a new one is saved in
  Settings (the owner chose speed over that, 2026-10-16).
- **Tests:** `test/voice`, `voice-key`.

## Visuals in a chat
- **Sees:** a framed page inside the chat, with no title bar: one small
  corner button ("Expand <title>", shown on hover, always on touch) opens it
  full size, where **Source** and **Save** are. It stays after the agent
  finishes or Helm restarts.
- **CLI:** `helm preview <file.html> [--output x.png] [--width 390]`, then
  `helm render <file.html> --title "<t>" [--session <id>]`.
- **Prove (driven):**
  ```sh
  echo '<div style="padding:20px">my visual ok</div>' > /tmp/v.html
  $H render /tmp/v.html --title "my visual" --session <chat-id>   # $H: see README
  # then open that chat in the app (Home → Settled → its title)
  $V wait "my visual"; $V shot /tmp/vis.png
  ```
- **Proof:** "my visual ok" inside the chat, and "Expand my visual" opening
  it with Source / Save.
- **Traps:** without `HELM_DIR` and `--session`, `render` posts into the
  owner's real chat. Pages are capped at 512 KiB; images at 2 MiB each.
- **Tests:** `test/visual-replies`; `test/browser/visual-replies`. See
  `docs/visual-replies.md`.

## Markdown, code and diffs in replies
- **Sees:** formatted replies, highlighted code, inline diffs (colours set
  in Appearance).
- **Prove:** steps not yet driven; the fake agent replies in plain text.
- **Tests:** `test/browser/markdown-loading`, `inline-diff`,
  `copy-selection`.
