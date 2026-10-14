# Browser use

Helm's normal browser is Chromium controlled through Playwright. It is for
using websites, checking local development apps, and completing browser
workflows alongside an agent. Agents can act on numbered controls, use
page coordinates for visual interaction, inspect text, run page JavaScript,
and read console/network diagnostics. On a computer the owner uses the same tabs
in a real Chromium window. Its controls operate inside web pages; it is not a general
desktop controller for arbitrary native apps or operating-system windows.

Press a chat’s **Browser** button or **Ctrl/⌘ Shift B**. On a wide screen
(1000px and up) the browser docks on the right of the chat, which stays usable
beside it; drag its left edge to resize it (double-click resets it). The width
is remembered on this device, and open/closed is remembered per chat. On a
phone it opens full screen with a close button. **Thread details → Browser**
opens the same panel. When the agent opens a tab in the chat you are viewing,
the dock opens by itself on a wide screen once per tab, unless you closed it
in that chat; otherwise a dot appears on the Browser button.

On a machine with a screen, each chat's browser is a real Chromium window on
that machine, beside Helm, with its own profile folder (it keeps what you sign
in to; a new chat starts with the default profile's logins). Opening the
browser at a computer brings the window forward. It never takes your
keyboard or mouse: the agent drives it from inside Chromium, not through the
desktop, so you can keep typing in Helm while it works, and you click the
window when you want to use it yourself. On niri this needs one window rule,
which matches the window's app id `helm-browser-<chat>`:

```kdl
window-rule {
    match app-id=r#"^helm-browser"#
    open-focused false
}
```

You and the agent can use the window at the same time. When you click, type
or scroll in it, the agent's next step waits until you have been still for
2.5 seconds (at most 20 seconds). Closing the window keeps its tabs, listed
as asleep; Show window, or the agent's next step on one, opens it again with
all of them. Listing tabs never opens the window.

The panel in Helm is the window's remote: the chat's tabs, back/forward/
reload with the address bar, **Show window**, **New tab** and **Read page**
(what the agent sees, as text), plus logins, downloads and any page message.
There is no picture of the page in Helm.

On a machine without a screen (the VM), agents use a hidden Chromium. The
panel there, and on a phone, lists the tabs and shows pages as text. The tabs
run on the chat's machine, so `localhost` reaches development servers there.

In the window the agent's clicks, hovers, typing, selects, uploads, drags and
scrolls show a cursor drawn on the page, with a short label such as
“Clicking “Sign in””, then it fades. The agent waits about 120ms before
acting so you can follow; hidden tabs have no cursor and no wait. **Show me**
mode: `helm browser point <tab> <element # or selector> --note "Click here to
approve"` (or the `point` action) highlights the element with the note and
changes nothing on the page. It stays until you click in the page or the
agent points elsewhere. It works in read-only chats; Bowser tabs do not
support it.

The existing `kind` actions, `ref`, CSS `selector`, `role` plus exact `name`,
exact text `name`, and coordinates still work. Other kinds include drag,
upload, evaluate, wait, resize, dialog, console, network, forward, reload and
point.
Use `--session <thread-id>` outside an agent chat. Read-only agents can read,
navigate, wait and check; batches containing a mutation are rejected before
any step.

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

A chat's window is its own Chromium process with its own profile; the hidden
browser is not started on a machine that can show windows. Nothing is
streamed to Helm: the panel asks for the tab list every two seconds while it
is open and visible.

The tab list is written to disk at most once a second after a burst of actions,
and at once on navigation, close, idle shutdown and stop. After ten minutes
without actions, inactive hidden Chromium contexts release their processes
and recover their saved tabs when next used. Text inspection and batched agent
actions avoid unnecessary screenshots and repeated model calls.

The implementation was informed by T3 Code’s `ServerBrowserContexts`,
`ServerBrowserStream`, browser ownership and automation patterns in the
October 13 source reference. Helm uses its existing Playwright dependency,
RPC transport and CLI; it does not run T3 Code or import its runtime.
