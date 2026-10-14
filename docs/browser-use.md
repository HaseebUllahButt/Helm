# Browser use

Helm's normal browser is Chromium controlled through Playwright. It is for
using websites, checking local development apps, and completing browser
workflows alongside an agent. Agents can act on numbered controls, use
page coordinates for visual interaction, inspect text, run page JavaScript,
and read console/network diagnostics. The live viewer lets the owner take
over the same tab. Its controls operate inside web pages; it is not a general
desktop controller for arbitrary native apps or operating-system windows.

Press a chat’s **Browser** button or **Ctrl/⌘ Shift B**. On a wide screen
(1000px and up) the browser docks on the right of the chat, which stays usable
beside it; drag its left edge to resize it (double-click resets it). The width
is remembered on this device, and open/closed is remembered per chat. On a
phone it opens full screen with a close button. **Thread details → Browser**
opens the same panel. When the agent opens a tab in the chat you are viewing,
the dock opens by itself on a wide screen once per tab, unless you closed it
in that chat; otherwise a dot appears on the Browser button.

The panel is a tab strip, back/forward/reload with the address bar, and the
live page. Clicking or typing on the page takes control and does that click;
a pill shows **You’re in control · Hand back**. Hand back lets the agent
continue. While you have control the agent’s actions are refused, as before.
The rarely used tools sit behind **⋯**: Read page, Console, Network, phone
and desktop sizes, copying the page clipboard, preview quality, typing or
clicking by element number, uploads and downloads. The tab runs on the
thread’s machine: `localhost` reaches development servers there, including
when you watch from a phone.

While someone watches, the agent’s clicks, hovers, typing, selects, uploads,
drags and scrolls show a pointer that glides to the spot with a short label
such as “Clicking “Sign in””, then fades. The server waits about 120ms before
acting so the viewer can follow; with nobody watching there is no pointer
work and no wait. **Show me** mode: `helm browser point <tab> <element # or
selector> --note "Click here to approve"` (or the `point` action) highlights
the element with the note and changes nothing on the page. It stays until
you click in the page, the agent points elsewhere, or a minute passes. It
works in read-only chats and while you have control; Bowser tabs do not
support it.

**Preview → Auto** reduces image size and frame rate when delivery slows down,
using network hints where available and measured replies on every browser.
Choose **Low data** to hold that setting, **Full quality** for finer detail,
or **Text only** to stop all image downloads while keeping text inspection,
navigation and control available. Preview quality never resizes the actual
page or changes agent actions. When several people view the same tab, the
slowest visual viewer sets the shared capture quality.

Agents use the same tabs through the CLI:

```sh
helm browser open http://localhost:3000
helm browser tabs
helm browser look <tab-id>
helm browser act <tab-id> '{"kind":"batch","actions":[{"kind":"type","selector":"#name","text":"Ada"},{"kind":"click","role":"button","name":"Save"}]}'
helm browser screenshot <tab-id> --output /tmp/page.jpg
helm browser point <tab-id> 4 --note "Click here to approve"
helm browser close <tab-id>
```

Use `--session <thread-id>` outside an agent chat. Element numbers returned by
`look` can be used as `ref`; look again after a page changes. Other actions
include hover, drag, key, scroll, select, upload, evaluate, wait, resize,
dialog, back, forward, reload and point. A failed batch stops at its failed step and
returns the current page; inspect it before submitting the remaining steps.
For uploads, agents pass `files` containing host file paths. The viewer can
send up to ten files and 8 MiB total through Helm. Downloads up to 8 MiB can
be saved in the viewer; larger files up to 128 MiB remain on the host while
the tab stays open. Each tab retains at most twenty downloads, with 256 MiB
total retained per thread. Older files expire when that limit is reached.
Closing a tab removes its retained downloads.

Chromium is shared across thread contexts, with separate cookies and site
storage for each thread. Cookies, local storage, IndexedDB and tab addresses
are saved privately under `~/.helm/browser` and recovered on demand after a
restart. Browser actions, pending navigation and page form state are not
replayed. Chromium must be installed on the host; Helm uses an existing
browser, `HELM_CHROMIUM_PATH`, or Playwright’s installed Chromium. It never
downloads a browser during daemon startup.

## Logins

The standard browser keeps login state separately for each thread. Sign in
through its viewer and the thread can reuse that session after storage is
saved. It currently has no button to import a complete existing Chrome/Edge
profile. Playwright authentication state contains cookies and web storage,
which is a smaller format than a full browser profile.

## Bowser Computer Use

When `bowser-computer` is installed on the selected machine, choose **Bowser
shared browser** or run:

```sh
helm browser open https://example.com --engine bowser
helm browser act <tab-id> '{"kind":"bowser","tool":"act","args":{"actions":[{"click":"Sign in"}],"budget":3000}}'
```

This reuses Bowser’s existing browser and copied login profile through one
persistent MCP bridge. Its normal desktop stays independent of your normal
focus. Bowser’s existing human pause remains authoritative; Helm never
resumes it automatically. The shared Bowser tab can belong to one Helm thread
at a time. Use numbered controls, names and the text input controls in Helm;
its native viewer remains available for direct mouse interaction. Closing
the Helm tab disconnects the bridge and leaves the existing Bowser desktop
and apps running. `HELM_BOWSER_PATH` selects a custom executable.

## Resource behavior

The daemon imports no Playwright code and launches no browser until one is
needed. All Chromium contexts share one process tree. Live preview uses CDP
screencast frames, stores only the latest JPEG, and paces acknowledgements
to roughly five frames per second at full quality, two in balanced mode and
one in low-data mode. The viewer requests the next frame only after its
previous request and image decode finish; unchanged frames carry no image payload.
Streaming stops when a viewer closes or its bounded lease expires. The web
viewer adapts its lease to observed latency, capped at sixty seconds. A
hidden client stops requesting frames. Bowser previews are sampled at most
once per second and unchanged images are omitted. After ten minutes without
actions or viewers, inactive Chromium contexts release their processes and
recover their saved tabs when next used. Text inspection and batched agent
actions avoid unnecessary screenshots and repeated model calls.

The implementation was informed by T3 Code’s `ServerBrowserContexts`,
`ServerBrowserStream`, browser ownership and automation patterns in the
October 13 source reference. Helm uses its existing Playwright dependency,
RPC transport and CLI; it does not run T3 Code or import its runtime.
