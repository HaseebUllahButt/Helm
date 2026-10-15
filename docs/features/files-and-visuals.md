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
- **Prove:** steps not yet driven; the hidden browser has no microphone.
- **Traps:** speech goes through a machine's key; the VM's key was invalid
  in an old note.
- **Tests:** `test/voice`, `voice-key`.

## Visuals in a chat
- **Sees:** a framed page inside the chat with its title and **Expand**,
  **Source**, **Save**. It stays after the agent finishes or Helm restarts.
- **CLI:** `helm preview <file.html> [--output x.png] [--width 390]`, then
  `helm render <file.html> --title "<t>" [--session <id>]`.
- **Prove (driven):**
  ```sh
  echo '<div style="padding:20px">my visual ok</div>' > /tmp/v.html
  $H render /tmp/v.html --title "my visual" --session <chat-id>   # $H: see README
  # then open that chat in the app (Home → Settled → its title)
  $V wait "my visual"; $V shot /tmp/vis.png
  ```
- **Proof:** the card titled "my visual" with "my visual ok" inside and
  Expand / Source / Save.
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
