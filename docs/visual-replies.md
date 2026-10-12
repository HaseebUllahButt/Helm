# Visual replies

Ask an agent in Helm to explain something with a diagram, chart, comparison, or
interactive model. It can publish a small HTML page directly inside the chat.
The page is a saved snapshot: closing the agent or restarting Helm does not
remove it or leave the chat working. Expand opens a large view; Source shows the
HTML; Save downloads a standalone HTML file. This works in managed and native
CLI conversations and on phones.

For agents (or from a shell):

```sh
helm run --heavy -- helm preview diagram.html --output /tmp/diagram.png
helm run --heavy -- helm preview diagram.html --width 390 --appearance light
helm render diagram.html --title "Desk clamp clearance"
```

Preview prints its screenshot path, content height, console messages, and
JavaScript errors as JSON. Inspect the screenshot before publishing. It uses a
fresh headless Chromium without the owner's browser profile. Install Chromium
with `npx playwright install chromium` or set `HELM_CHROMIUM_PATH` to an installed
browser if no browser is available. Publishing and reading visuals need no
browser installed on the chat's machine.

Render uses `HELM_SESSION_ID` or `HELM_NATIVE_SESSION` to find this chat. Outside a
chat, pass `--session <chat-id>` (including a chat on another reachable machine).
Use `--height 420` to choose the initial height, between 120 and 1200 pixels. The
frame adjusts to the content up to 1200 pixels; longer pages scroll inside it.
If delivery is uncertain, the error prints a `--render-id` to retry the same
publication without duplicates. Different pages must have different IDs.

Use inline CSS, JavaScript, SVG, and canvas. Theme-aware pages can use `--bg`,
`--card`, `--raised`, `--text`, `--text-dim`, `--mutedfg`, `--line`, `--primary`,
`--primary-q`, `--amber`, `--sky`, `--emerald`, and `--red` CSS variables; theme
changes update those variables without resetting interactions. The page also
gets a light/dark `color-scheme` and `data-theme` on its root.

The HTML source may be up to 512 KiB. Local images in `img`, `srcset`, SVG image
references, video posters, and CSS `url()` are copied into the snapshot. Each
must be a recognized PNG, JPEG, GIF, WebP, AVIF, or SVG up to 2 MiB; extensions
alone do not establish that a file is an image. The complete snapshot is capped
at 4 MiB. HTTPS images and data URLs work too; embed images for a portable copy.
Assets loaded later through JavaScript are not embedded automatically.

Pages run in a sandbox with an opaque origin. They cannot read Helm's cookies,
storage, or parent document. External scripts, network fetches, nested frames,
forms, and plugins are blocked. Clicked HTTP/HTTPS links open in a separate tab;
fragment links stay inside the page. No dev server or background watcher is
needed. Files follow Helm's existing conversation retention policy and are
removed when the owning thread is deleted.
