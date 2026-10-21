/**
 * `helm help <command>` and `helm <command> --help`: the usage lines for that
 * command, plus the details agents used to get in every session's notes.
 * The notes now keep only rules; anything an agent can look up lives here,
 * read when it is needed instead of paid for in every chat.
 */

const DETAILS = {
  exec: `
  For pipelines: helm exec <machine> --cwd <path> -- sh -lc '<script>'.
  If it says the command may have started, never rerun it: read it with
  helm exec-status <machine> <id> --wait, or stop it with helm exec-cancel.`,

  copy: `
  The default target is the same path there; ~ is that machine's home.`,

  delegate: `
  Starts a helper attached to this chat: it shows as a card the owner can
  open, message and stop.
    <account>        same = this chat's account. Others: helm agents (names
                     differ per machine; on another machine use helm spawn)
    --model <id>     a model ID, or cheap for the account's small model
    --wait --json    block, then print the result as JSON
    --cwd <folder>   run in another folder
    --worktree       its own checkout of this repo on a new helm/ branch;
                     merge the branch back yourself, then remove both
    --mode --effort --timeout <ms>   as the account supports
  Finished helpers release their runtime after 30 seconds idle and resume the
  same conversation on a follow-up (Claude keeps its context for an hour).
  Read a helper later with helm delegate-result <id>; remove one with
  helm delete <id>.`,

  spawn: `
  <account> names differ per machine: helm exec <machine> -- helm agents.`,

  say: `
  Messages wait for the receiver's next turn; they never interrupt work.
  Inside a chat, the message names you as the sender.`,

  share: `
  These links are called spins. Use --keep only when the owner asks for a
  link that stays. helm forward <machine> <port> opens another machine's
  shared port on this one's localhost.`,

  spin: `
  An alias for helm share. See helm share --help for link options.`,

  canvas: `
  Opens the existing Canvas column beside the chat on wide screens. On
  phones it opens a full-screen canvas with a Close button.
  Markdown, text and code files open from the chat's Git project. Relative
  paths use your current folder, or the target chat's folder with --session.
  The canvas follows file edits and lets the owner edit and save safely.
  HTML and pictures are saved snapshots, like helm render. Run the command
  again after changing them to show the new version.
  An http/https spin URL shows a live website. Use the public spin address:
  localhost means the viewer's machine. Sites that block frames or require
  a separate login can use Open in new tab.
  Supports --title, --height, --session and --render-id like helm render.
  See helm render --help for snapshot limits and security.`,

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
  Tabs are Chromium on this machine (localhost reaches your dev servers),
  shared with the owner: on a machine with a screen they are a real window
  beside Helm that never takes the owner's keyboard; your steps wait while
  the owner uses it. --engine bowser uses Bowser Computer Use when installed.
    look <tab>        page text and numbered elements, no screenshot
    act <tab> <JSON>  a batch: '{"actions":[{"click":"the Save button"},{"check":"Saved"}]}'
                      checks use literal page text or targets, not questions.
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
  Deletes a chat Helm started: its card, its row and the CLI's copy Helm would
  list again. A chat Helm only watched stops being watched; its transcript
  stays. It never deletes the chat you run in.`,
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
