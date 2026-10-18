# Visual replies

An agent can publish a small HTML page (a diagram, chart or interactive
model) inside the chat. It is a saved snapshot: stopping the agent or
restarting Helm does not remove it. It works in managed and native CLI
chats and on phones.

```sh
helm run --heavy -- helm preview diagram.html --output /tmp/diagram.png
helm run --heavy -- helm preview diagram.html --width 390 --appearance light
helm render diagram.html --title "Desk clamp clearance"
```

Preview prints the screenshot path and JavaScript errors as JSON; look at
the screenshot before publishing. It needs Chromium (`npx playwright install
chromium` or `HELM_CHROMIUM_PATH`); render does not.

## Things that surprise

- Render finds the chat from `HELM_SESSION_ID` or `HELM_NATIVE_SESSION`.
  Outside a chat pass `--session <chat-id>`.
- If delivery is uncertain, the error prints a `--render-id`; retry with it
  to avoid a duplicate. Different pages need different ids.
- The frame grows to 1200 px, then the page scrolls inside it.
- Limits: HTML 512 KiB, whole snapshot 4 MiB. Local images (`img`,
  `srcset`, SVG images, posters, CSS `url()`) are copied in; each must
  really be a PNG, JPEG, GIF, WebP, AVIF or SVG up to 2 MiB (the extension
  is not trusted). Assets loaded later by JavaScript are not embedded.
- Theme variables: `--bg`, `--card`, `--raised`, `--text`, `--text-dim`,
  `--mutedfg`, `--line`, `--primary`, `--primary-q`, `--amber`, `--sky`,
  `--emerald`, `--red`. They update on theme change without resetting the
  page.

## Security decisions

Pages run in a sandbox with an opaque origin: no access to Helm's cookies,
storage or parent page. The frame loads a separate document with its own
security policy, so inline scripts work under Helm's strict app policy; the
saved HTML reaches it through the parent after a signed-in read. External
scripts, network fetches, nested frames, forms and plugins are blocked.
Visuals are removed when their chat is deleted.
