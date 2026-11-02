# Visual replies

Use plain text by default. Publish a visual only when the owner asks.
Reviews have no fixed finding count. Keep verification screenshots private
unless the owner asks to see them.

An agent can publish a small HTML page (a diagram, chart or interactive
model) inside the chat. It is a saved snapshot: stopping the agent or
restarting Helm does not remove it. It works in managed and native CLI
chats and on phones. `helm canvas` opens the same snapshot in the existing
Canvas column beside chat. Project text files open in the Canvas editor;
spin URLs open as live pages. The newest agent request is saved on the chat,
so a disconnected viewer receives it on reconnect. Each device remembers a
closed request and reopens only for a new request.

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
- Look (borrowed from T3 Code, 2026-11-01): a page has no frame, border or
  card of its own in the chat. It sits on the chat background and lines up
  with the reply text. Every page starts from `VISUAL_BASE_CSS`
  (protocol/visual.js): Helm's font, 14 px text and colours. The live theme
  goes into a style element at the top of the head, never inline on
  `<html>`, so a page's own `:root` rules still win. `helm render --help`
  holds the layout rules agents get; most of the look comes from them.
- Theme variables: `--bg`, `--card`, `--raised`, `--text`, `--text-dim`,
  `--mutedfg`, `--line`, `--primary`, `--primary-q`, `--amber`, `--sky`,
  `--emerald`, `--red`, `--radius`, `--font-sans`, `--font-mono`, plus
  shadcn names (`--background`, `--foreground`, `--border` …) that point
  at them. They update on theme change without resetting the page.
- Chart colours come from the dataviz skill's reference palette (owner,
  2026-11-02): `--chart-1` to `--chart-8` in a fixed order, `--grid`,
  `--axis`, and status `--good`/`--warning`/`--serious`/`--critical`. Each
  has a dark and a light step (`CHART_DARK`/`CHART_LIGHT`), checked with
  the skill's `validate_palette.js` on Helm's dark, navy and light
  backgrounds. Do not swap one colour by eye: the order is what keeps
  neighbours apart for colour-blind readers. The chart rules agents get
  are in `helm render --help`.

## Diagrams in replies

A ```` ```mermaid ```` block in a finished reply is drawn as a diagram
(apps/web/src/diagrams.ts), as in T3 Code. Agents are told to use it
instead of boxes made of text characters. While the reply streams it stays
code: a half-written diagram would flicker and fail. Mermaid (about 1 MB)
loads only when a diagram is on screen. It runs in strict mode with HTML
labels off; a diagram cannot change the theme, the font or those settings.
Boxes are grey with hairline edges, never the accent colour; pie slices,
timelines and other coloured parts take the chart colours above.
Its SVG is cleaned again: no links, pictures, scripts or remote CSS. A
diagram with an error stays as code with the reason.

## Security decisions

Pages run in a sandbox with an opaque origin: no access to Helm's cookies,
storage or parent page. The frame loads a separate document with its own
security policy, so inline scripts work under Helm's strict app policy; the
saved HTML reaches it through the parent after a signed-in read. External
scripts, network fetches, nested frames, forms and plugins are blocked.
Visuals are removed when their chat is deleted.

Live canvas URLs use a separate frame that allows scripts, forms, popups
and the site's own origin so storage and JavaScript modules work. The UI
refuses to frame Helm's own origin; Helm's response policy also blocks
embedding its pages after a redirect. Saved HTML keeps its opaque origin
and stricter policy. Sites blocking frames or needing a separate login use
the visible new-tab link. URLs are never fetched by the daemon.
Project files use the existing Canvas read and save guards; opening a file
never changes provider work or starts an agent.
