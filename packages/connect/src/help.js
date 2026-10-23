/**
 * `helm help <command>` and `helm <command> --help`: the usage lines for that
 * command, plus the details agents used to get in every session's notes.
 * The notes now keep only rules; anything an agent can look up lives here,
 * read when it is needed instead of paid for in every chat.
 */

const DETAILS = {
  exec: `
  Run pipelines with: helm exec <machine> --cwd <path> -- sh -lc '<script>'.
  Do not rerun a command if Helm cannot confirm that it started.
  Read it with helm exec-status <machine> <id> --wait.
  Stop it with helm exec-cancel.`,

  copy: `
  The default destination uses the same path on the other machine.
  ~ means that machine's home folder.`,

  delegate: `
  Start a helper for this chat.
  The owner sees a card to open, message or stop the helper.
    <account>        Use same for this chat's account.
                     Run helm agents to list accounts on this machine.
                     Use helm spawn for another machine.
    --model <id>     Pick a model ID, or cheap for the account's small model.
    --wait --json    Wait for the result, then print it as JSON.
    --cwd <folder>   Run in another folder.
    --worktree       Use a separate project copy on a new helm/ branch.
                     Merge the branch yourself, then remove the branch and copy.
    --mode --effort --timeout <ms>   Use options that the account supports.
  Helm closes helper software after 30 seconds without work.
  A follow-up message resumes the same chat.
  Claude keeps its context for an hour.
  Read a helper with helm delegate-result <id>.
  Keep finished helpers. The owner reads them under this chat.`,

  spawn: `
  Account names (<account>) differ between machines.
  Run helm exec <machine> -- helm agents to list them.`,

  say: `
  Messages wait for the receiver's next turn.
  Messages do not interrupt work.
  In a chat, the message shows you as the sender.`,

  share: `
  Spins are public links.
  Use --keep only when the owner asks for a link that stays open.
  Run helm forward <machine> <port> to open another machine's shared port on this machine's localhost.`,

  spin: `
  This command runs helm share.
  Run helm share --help for link options.`,

  canvas: `
  Open Canvas beside the chat on wide screens.
  On phones, Canvas fills the screen and has a Close button.
  Open Markdown, text and code files from the chat's folder.
  Relative paths start from your current folder.
  With --session, paths start from the selected chat's folder.
  Canvas shows file changes and lets the owner edit and save files.
  HTML pages and pictures show a saved copy, like helm render.
  Run the command again after edits to show the new copy.
  Use an http/https Spin URL to show a live website.
  Use the public Spin address.
  localhost means the viewer's machine.
  Use Open in new tab if the site blocks frames or needs a separate login.
  Use --title, --height, --session and --render-id as with helm render.
  Run helm render --help for saved page limits and access rules.`,

  render: `
  A picture file (png, jpg, gif, webp, avif, svg) is shown as it is.
  Otherwise write one self-contained HTML file: inline CSS/JS, SVG or canvas.
  It runs in an isolated frame: no app state, network fetch, external
  scripts or forms. Local images (img/srcset, SVG, CSS url()) are embedded:
  each a real image up to 2 MiB, the whole page up to 4 MiB. For theme-aware
  colours use --bg --card --text --text-dim --line --primary-q.
  Check it first with helm preview (--width 390 for a phone), fix any
  reported JavaScript errors, then helm render saves it in this chat.
  Use helm canvas instead to open the visual beside the conversation.`,

  browser: `
  Tabs use Chromium on this machine.
  localhost reaches your development servers.
  The owner shares these tabs with you.
  On machines with a screen, tabs open in a window beside Helm.
  The window does not take keyboard control.
  Your actions wait while the owner uses the window.
  Use --engine bowser for Bowser Computer Use, if installed.
    look <tab>        Read page text and numbered elements without a screenshot.
    act <tab> <JSON>  Run actions: '{"actions":[{"click":"the Save button"},{"check":"Saved"}]}'
                      Use exact page text or targets for checks.
                      Kinds: click, type, goto, check, key, scroll, hover, select,
                      upload/files, evaluate/script, wait/selector, resize,
                      dialog, console, network, back, forward, reload; or
                      kind/ref, selector, role/name and coordinates.
                      A failed batch stops and lists candidate elements.
    flows / run       save a repeating batch with {{param}}, values, save_as
                      and note; replay it with run <tab> <name> key=value
    point <tab> <el>  show the owner where to click, without clicking
    screenshot        only when visuals matter; close <tab> releases it
    profiles / logins copy the owner's browser logins into these tabs`,

  delete: `
  Delete a chat that Helm started, including its card, row and command line copy.
  Helm stops watching chats that it did not start and keeps their saved messages.
  This command cannot delete the chat you run it in.
  An agent cannot delete a helper unless it adds --helper. Add it only when the owner asks.`,
};

/** Usage blocks: a `  helm <word>` line and the deeper-indented lines under it. */
function blocks(usage) {
  const out = [];
  for (const line of usage.split('\n')) {
    const head = line.match(/^ {2}helm (\S+)/);
    if (head) out.push({ word: head[1], lines: [line] });
    else if (/^ {3,}\S/.test(line) && out.length) out.at(-1).lines.push(line);
    else out.push({ word: null, lines: [] });
  }
  return out.filter((b) => b.word);
}

/** Help for one command, or null when the usage has nothing for it. */
export function commandHelp(command, usage) {
  const want = String(command ?? '').toLowerCase();
  if (!want) return null;
  // exec also shows exec-status and exec-cancel; delegate shows delegate-result.
  const own = blocks(usage).filter((b) => b.word === want || b.word.startsWith(`${want}-`));
  const details = DETAILS[want];
  if (!own.length && !details) return null;
  return [...own.flatMap((b) => b.lines), ...(details ? [details.replace(/^\n/, '')] : [])].join('\n');
}

/** `helm <command> --help` asks for help only before `--`; after it, words are a task. */
export function wantsHelp(args) {
  const end = args.indexOf('--');
  return (end < 0 ? args : args.slice(0, end)).some((a) => a === '--help' || a === '-h');
}
