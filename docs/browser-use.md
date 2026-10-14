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

Agents use the same tabs through the CLI. Plan the whole task as one batch,
prefer direct URLs, name controls plainly, and check steps that must work:

```sh
helm browser open http://localhost:3000
helm browser act <tab-id> '{"actions":[{"type":"Ada","into":"the Name box","clear":true},{"click":"the Save button"},{"check":"Saved","expect":true}]}'
helm browser screenshot <tab-id> --output /tmp/page.jpg
helm browser point <tab-id> 4 --note "Click here to approve"
helm browser close <tab-id>
```

Each action returns the settled page, including numbered controls and their
state. Use that reply instead of looking again. Text budgets still limit page
prose (`budget: 0` keeps controls only); at most 300 controls are listed.
Password values are excluded. Same-origin frames and open shadow roots are
included. A plain target matches names and role words deterministically;
Helm makes no model calls to choose a control. A missing or ambiguous target
stops the batch and returns likely candidates with element numbers. Submit
only the remaining steps with a corrected target or `ref`.

Bowser-style steps work in a batch or alone: `goto`, `click`, `type` with
`into`, `clear` and `enter`, `key`, `select` with `option` (the option's label),
`hover`, `scroll` with `up`/`down` and `pages`, `wait_for`, `back`, and `check`.
Typing appends by default; `clear: true` replaces the field. Checks match
literal, case-sensitive page text or a named control; they do not answer
questions. `expect` defaults to `true`; a failed check stops the batch and
returns its pass/fail result. Navigation and data requests settle before the
reply: load completion and a 150 ms quiet period for fetch/XHR, capped at
three seconds. A quiet static page incurs no fixed action delay. Long-lived
requests can reach the cap; use `wait_for` for content that needs longer.

The existing `kind` actions, `ref`, CSS `selector`, `role` plus exact `name`,
exact text `name`, and coordinates still work. Other kinds include drag,
upload, evaluate, wait, resize, dialog, console, network, forward, reload and
point.
Use `--session <thread-id>` outside an agent chat. Read-only agents can read,
navigate, wait and check; batches containing a mutation are rejected before
any step. Human control still stops agent actions and cancels later batch
steps.

Save a repeating task from its successful run, without repeating it:

```sh
helm browser act <tab-id> '{"actions":[{"type":"{{name}}","into":"the Name box","clear":true},{"click":"the Save button"},{"check":"Saved"}],"with":{"name":"Ada"},"save_as":"save-name","note":"Save a name"}'
helm browser flows
helm browser run <tab-id> save-name name=Grace
```

Flows are saved only if every step succeeds. Their original parameter
placeholders are kept in private (0600) files at
`~/.helm/browser/flows/<name>.json`, shared on that machine. Names use
lowercase letters, digits, `-` and `_`, up to 64 characters. Every parameter
must be supplied when running a flow. Prefer names or selectors over element
numbers in saved flows, since numbers can change on another visit.

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

Choose **Logins** in the browser toolbar to copy cookies from a Chromium,
Chrome, Brave, Edge or Vivaldi profile on the thread’s machine. Pick a profile,
then **Use in this chat**. **Refresh** reads it again. Only cookies come across;
history, passwords, extensions, caches and source-profile site storage stay
behind. Sites that also need local storage or device-bound tokens may still
ask you to sign in through the viewer.

**Use for all new chats** also saves that profile choice on this machine. New
chat browsers read its latest cookies; chats with saved browser storage keep
their own state. **Clear default** removes the choice without signing existing
chats out. Cookies are saved only in each chat’s private storage file; the
machine default file contains just the profile key. Imported cookies stay in
memory for at most ten minutes between reads; Refresh bypasses that cache.

```sh
helm browser profiles
helm browser logins "chromium:Profile 3"
helm browser logins "Work" --default
helm browser logins --clear-default
```

Profile names or directories work too; if a name matches several profiles,
Helm lists the choices. Output contains only profile labels and counts.
Linux supports basic, libsecret and KWallet cookie keys, using the browser’s
password-store flag where present. Unlock the matching keyring if cookies
cannot be copied. macOS keychain support is best effort. Windows profiles are
listed, but importing their app-bound encrypted logins is unavailable.
Copying needs Node’s SQLite support (Node 22.16 or newer).

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
