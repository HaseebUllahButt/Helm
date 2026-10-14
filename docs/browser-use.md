# Browser use

Helm's normal browser is Chromium controlled through Playwright. It is for
using websites, checking local development apps, and completing browser
workflows alongside an agent. Agents can act on numbered controls, use
page coordinates for visual interaction, inspect text, run page JavaScript,
and read console/network diagnostics. The live viewer lets the owner take
over the same tab. Its controls operate inside web pages; it is not a general
desktop controller for arbitrary native apps or operating-system windows.

Open a thread’s **Browser** button, or **Thread details → Browser**. Open a tab,
then take control to navigate, click, type, paste, scroll, answer dialogs,
upload files, or save downloads. Release control to let the agent continue.
The tab runs on the thread’s machine: `localhost` reaches development servers
there, including when you watch from a phone. Read page & controls gives a
text view; Console and Network show bounded diagnostics. The viewport buttons
switch between phone and desktop sizes.

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
helm browser close <tab-id>
```

Use `--session <thread-id>` outside an agent chat. Element numbers returned by
`look` can be used as `ref`; look again after a page changes. Other actions
include hover, drag, key, scroll, select, upload, evaluate, wait, resize,
dialog, back, forward and reload. A failed batch stops at its failed step and
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
needed. All Chromium contexts share one process tree. Helm starts Playwright’s
own headless Chromium (`chromium_headless_shell`) when it is installed: it
starts in about 0.2 s and uses roughly half the memory of full Chromium. If it
is missing, Helm falls back to the system Chromium. `HELM_CHROMIUM_PATH`
pins a specific browser and skips the headless shell; set it if a site refuses
the headless shell (it has no `window.chrome` object, so some bot checks
notice it).

Live preview uses CDP screencast frames and stores only the latest JPEG.
There are four visual tiers, plus text only: low data (about 1 frame/s),
balanced (2/s), full (5/s) and smooth (up to about 30/s, for a quick link).
Auto starts at full, measures the round trip, and moves to smooth, balanced or
low data as the link allows; a phone-sized screen stays at balanced or lower.
A viewer asks for the next frame with `browser.frame { since, waitMs }`; the
host holds the request (at most 1.5 s) until the page paints something new, so
frames arrive as soon as they exist and nothing polls while the page is still.
`waited` in the answer is the time the host held it. Unchanged frames carry no
image. When the owner clicks, types or scrolls, the host acknowledges paints
without pacing for 0.4 s, so the result shows at once. Streaming stops when a
viewer closes or its bounded lease expires. The web viewer adapts its lease to
observed latency, capped at sixty seconds. A hidden client stops requesting
frames. Bowser previews are sampled at most once per second and unchanged
images are omitted.

The tab list is written to disk at most once a second after a burst of actions,
and at once on navigation, close, idle shutdown and stop. After ten minutes
without actions or viewers, inactive Chromium contexts release their processes
and recover their saved tabs when next used. Text inspection and batched agent
actions avoid unnecessary screenshots and repeated model calls.

Measure it yourself with `node scripts/browser-bench.mjs` (cold start, memory
of the whole process tree, action and input latency, frame rate, idle CPU).

The implementation was informed by T3 Code’s `ServerBrowserContexts`,
`ServerBrowserStream`, browser ownership and automation patterns in the
October 13 source reference. Helm uses its existing Playwright dependency,
RPC transport and CLI; it does not run T3 Code or import its runtime.
