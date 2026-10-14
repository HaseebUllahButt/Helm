# Browser use

Open a thread’s **Browser** button, or **Thread details → Browser**. Open a tab,
then take control to navigate, click, type, paste, scroll, answer dialogs,
upload files, or save downloads. Release control to let the agent continue.
The tab runs on the thread’s machine: `localhost` reaches development servers
there, including when you watch from a phone. Read page & controls gives a
text view; Console and Network show bounded diagnostics. The viewport buttons
switch between phone and desktop sizes.

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
be saved in the viewer; larger files remain on the host.

Chromium is shared across thread contexts, with separate cookies and site
storage for each thread. Cookies, local storage, IndexedDB and tab addresses
are saved privately under `~/.helm/browser` and recovered on demand after a
restart. Browser actions, pending navigation and page form state are not
replayed. Chromium must be installed on the host; Helm uses an existing
browser, `HELM_CHROMIUM_PATH`, or Playwright’s installed Chromium. It never
downloads a browser during daemon startup.

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
to roughly five frames per second. The viewer requests the next frame only
after its previous request finishes; unchanged frames carry no image payload.
Streaming stops when a viewer closes or its ten-second lease expires. A
hidden client stops requesting frames. Bowser previews are sampled at most
once per second and unchanged images are omitted. After ten minutes without
actions or viewers, inactive Chromium contexts release their processes and
recover their saved tabs when next used. Text inspection and batched agent
actions avoid unnecessary screenshots and repeated model calls.

The implementation was informed by T3 Code’s `ServerBrowserContexts`,
`ServerBrowserStream`, browser ownership and automation patterns in the
October 13 source reference. Helm uses its existing Playwright dependency,
RPC transport and CLI; it does not run T3 Code or import its runtime.
