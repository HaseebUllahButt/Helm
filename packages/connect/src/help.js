/**
 * `helm help <command>` and `helm <command> --help`: the usage lines for that
 * command, plus the details agents used to get in every session's notes.
 * The notes now keep only rules; anything an agent can look up lives here,
 * read when it is needed instead of paid for in every chat.
 */

/** Every command and option, for helm help --all and the per-command lookup below. */
export const USAGE = `helm - Control your coding agents from anywhere

  helm setup [https-url]             Set up this VM as your Helm home
  helm open                          Open the app here, signed in
  helm app [--remove]                Add Helm to this desktop's applications

  helm add controller                Add a phone or browser to control machines
  helm add pc                        Add a computer to run agents and control machines
  helm add vm                        Add a VM that other machines connect to
  helm join                          Paste a private link to join a network
  helm join <private-link>           Join a network with the copied link
  helm start                         Start Helm in the background

  helm join <CODE> <home-url> --foreground   Run Helm in this terminal
  helm network-repair                Keep connections working when large network packets fail on Linux

  helm up [--port N] [--tunnel]      Run Helm in this terminal
  helm up --tunnel --domain <d>     Make a fixed public link (needs a free ngrok account)
  helm up --tunnel --temporary      Make a temporary public link without an account
  helm up --advertise <url>         Set the public address for this machine
  helm up --host <address>          Set the local address (default 0.0.0.0)
  helm up --install                 Start Helm each time this machine starts

  helm link [minutes]               Add a phone or browser, like 'helm add controller'
  helm join <CODE> --at <url>       Join a network, like 'helm join CODE url'

  helm devices                      controllers that can drive this network
  helm browser open <url>            browse with your agent (Chromium or --engine bowser)
  helm browser tabs | look <id>      list tabs or read text and numbered controls
  helm machines                     machines in this network
  helm redesignate [machine] <kind> what a machine is for: pc or vm
  helm spin <port> [options]         same as helm share; make a public link
  helm share <port> [--name <n>] [--password [pw]] [--private] [--for <hours>] [--keep]
    Make a Spin, a public link that ends after 3 hours unless you use --keep.
                                  The link opens a port on this machine through your VM.
    --private                     Limit access to devices signed in to your Helm
    --preserve-host               Send the Spin host to the app instead of localhost
  helm share list | stop <name>   List or stop Spins
  helm share setup                Set up the VM to serve Spins
  helm share <port> --to <machine>  Same as helm forward <port> --to <machine>
  helm forward <port> [--to <machine>] [--local <port>] [--for <hours>] [--keep]
                                  Open a port of this machine on the owner's machine
                                  as http://localhost:<port>. No public link.
                                  Without --to: the machine the owner used last.
  helm forward <machine> <port>   Open another machine's port on this machine's localhost
  helm forward list | stop <id|port|all>
                                  List or stop forwards (a stop removes both sides)
  helm remove <id>                  Remove a device or machine permanently
  helm leave                        Remove this machine from its network

  helm login [minutes]              Make a temporary password to sign in a device
  helm status                       Show machines, links and agent software
  helm profiles [--refresh]         List agent accounts on this machine
  helm agents [--json] [--refresh]  List command line accounts, sign-in status and model IDs
  helm run -- <command> [args]      Run a command here through Helm
  helm exec <machine> [--cwd <path>] -- <command> [args]
                                    Run a command on another machine through Helm
    --env NAME=value               Set a command environment value (repeat this flag for more values)
    --timeout <milliseconds>       Set the command time limit (default 15 minutes)
  helm exec-status <machine> <id> [--wait] [--json]
                                    Read command output after a connection loss
  helm exec-cancel <machine> <id>   Stop a command started earlier
  helm antigravity [install|login|status|remove]   Install or manage the Google Antigravity agent

  helm brain                       Open the Helm brain on the VM
  helm digest [--json]              Show every machine, folder and running chat
  helm search <words...> [--json]   Find chats with these words on every machine, newest first
  helm thread <id> [-n 40]          Read recent messages from a chat
  helm delete <id>                  Delete a chat
  helm pickup [chat-id] [-n 3]      Show where earlier project chats stopped on every machine
                                    Show requests, unfinished work, commits and unsaved changes
  helm say <id> <text...>           Send a message from this agent (a plain prompt outside a chat)
  helm reply <message-id> <text...> Reply to an agent message
  helm messages [chat-id] [--json]  Read messages in this chat and its Agents
  helm canvas <file | https://…> [--title <text>] [--session <id>]
                                    Open a project file, saved picture or live page beside the chat
  helm render <file.html | picture.png> [--title <text>] [--height <px>] [--session <id>]
                                    Save a picture, HTML page or screenshot in this chat
  helm preview <file.html> [--output <file.png>] [--width <px>] [--appearance dark|light]
                                    screenshot a visual and report JavaScript errors
  helm chat <account> [-- text]    share a live agent between this terminal and the app
  helm chat --attach <id>          reconnect to the same managed session
  helm chat <account> --resume <id> continue a native conversation after its CLI closes
  helm chat <account> --quick      a chat with no folder, for a small question
  helm integrate [--remove]        manage automatic control of normal CLI commands
  helm spawn <machine> <folder> <account> <text...>   start a session and prompt it
  helm spawn <machine> - <account> <text...>          the same, as a quick chat with no folder
    --mkdir --wait [--timeout <ms>]  create the folder; print the first completed reply
  helm delegate <account> --model <id> --wait --json -- "<task>"
                                    Start a helper in this folder
  helm delegate-result <id> [--wait] [--json]   Read the helper result or approval request
  helm handoff <machine> [text...]  Move code and this task to another machine
    --handoff-id <id>               Continue a stopped task move with the same ID
  helm dispatch <machine> [text...]  Send this folder and task when the other machine connects
  helm dispatch-status <id>         Show progress for a task sent to another machine
  helm send-task <machine> --account <id> [text...]  Send files, .env and a task directly
    --no-env --allow-skipped --handoff-id <id>       Control .env files, skipped files and retries
  helm receive <source> [minutes]   Allow this machine to receive one folder from <source>
  helm send <machine> [folder] --grant <token>
                                  Send a folder with the receiving machine's permission
    --target-folder <folder>        Set the folder on the receiving machine
    --include-env                   Include .env files with access for the receiving user only
    --dry-run                       Preview files to send without permission from the receiving machine
    --allow-skipped                 Send files and allow skipped files
  helm copy <machine> <file-or-folder> [--target-folder <path>]
                                  Copy through Helm and resume if stopped (needs rsync 3.2.3+ on both machines)
    --target-folder <path>          Set the destination (default: same path; ~ means the other machine's home folder)
    --exclude <pattern>             Skip matching files (repeat this flag for more patterns)
    --dry-run                       Preview the copy, including hidden files
    --direct | --relay | --ssh      Pick a connection (default: Helm picks one)
    --retries <0-5>                 Set retries after connection loss (default: 2)
  helm verify <folder> [-- cmd...]  Check what a received folder still needs

  helm dictate [--to <id>]          Start recording; run again to stop and turn speech into text
  helm proxy <host>                 Connect through SSH ProxyCommand (used by ~/.ssh/config)
  helm self-update                  Get the newest Helm and restart it on this machine
  helm ship                         Merge this branch into main, push it and install it on every online machine
    --no-check                      Skip npm run check before the merge
    --wait <minutes>                Wait this long for the machines to restart (default: 10)
  helm service install|uninstall    Install or remove the background service

Add devices from Settings, or run 'helm add' on a joined machine.
Paste a computer's private join link into 'helm join'.
A control device stays signed in until you remove it.
Passwords add devices and expire in minutes.
Run helm help <command> or helm <command> --help for details.
`;

/**
 * What plain `helm help` prints: one line per command, no options. Agents
 * read it often, so it stays small (test/agent-context-budget.json); the
 * options are one `helm help <command>` away.
 */
export const OVERVIEW = `helm - Control your coding agents from anywhere

Set up this machine
  setup            Set up this VM as your Helm home
  add              Add a phone, browser, computer or VM
  join             Join a network with a private link
  start            Start Helm in the background
  up               Run Helm in this terminal, or make a public link
  open             Open the app here, signed in
  app              Add Helm to this desktop's applications
  login            Make a temporary password to sign in a device
  link             Add a phone or browser, like helm add controller
  status           Show machines, links and agent software
  network-repair   Fix connections when large packets fail on Linux
  self-update      Get the newest Helm and restart it here
  ship             Merge, push and install a Helm change everywhere
  service          Install or remove the background service
  antigravity      Install or manage the Google Antigravity agent
  leave            Remove this machine from its network

Machines and devices
  machines         List the machines in this network
  devices          List the devices that control this network
  redesignate      Set what a machine is for: pc or vm
  remove           Remove a device or machine permanently
  exec             Run a command on another machine
  exec-status      Read a command's output after a connection loss
  exec-cancel      Stop a command started earlier
  run              Run a command here through Helm
  copy             Copy files to another machine; resume if stopped
  send, receive    Send a folder with the other machine's permission
  send-task        Send files, .env and a task to another machine
  handoff          Move code and this task to another machine
  dispatch         Send this folder and task when a machine connects
  dispatch-status  Show progress for a task sent to another machine
  verify           Check what a received folder still needs
  forward          Open a port on the owner's machine as a localhost link
  proxy            Connect through SSH ProxyCommand

Chats and agents
  agents           List accounts, sign-in status and model IDs
  profiles         List agent accounts on this machine
  digest           Show every machine, folder and running chat
  search           Find chats by words on every machine
  thread           Read recent messages from a chat
  pickup           Show where earlier project chats stopped
  spawn            Start a chat on a machine and prompt it
  chat             Share a live agent between this terminal and the app
  delegate         Start a helper for this chat
  delegate-result  Read a helper's result
  say, reply       Send a message to an agent, or answer one
  messages         Read messages in this chat and its helpers
  delete           Delete a chat
  brain            Open the Helm brain on the VM
  integrate        Control normal CLI commands automatically
  dictate          Record speech and turn it into text

Pages and links
  browser          Use Chromium tabs that the owner also sees
  share, spin      Make a public link (a Spin) to a port here
  preview          Take a screenshot of an HTML file; report script errors
  render           Save a picture or HTML page in this chat
  canvas           Open a file, picture or live page beside the chat

Run helm help <command> for its options, or helm help --all for all of them.
`;

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
                     Merge the branch when you want the work.
                     Never remove the copy: Helm removes it once merged,
                     or after an hour of quiet, and keeps an unmerged branch.
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
  To show the owner a dev server, use helm forward <port> instead.
  It needs no public link, and the app sees a localhost visit.`,

  forward: `
  Show the owner a dev server that runs on this machine:
    helm forward <port>
  Run it yourself. Do not ask the owner to run a command.
  Helm opens the port on the machine the owner used last and prints it.
  Add --to <machine> to pick the machine.
  Give the owner only the http://localhost link that Helm prints.
  The Helm service keeps the forward open after your shell ends,
  after restarts and after the app restarts.
  When the app is not running, the link shows a "not reachable" page.
  It ends after 3 hours. Use --for <hours>, or --keep only when the owner asks.
  Stop it with helm forward stop <id>. This removes both sides.`,

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
  On machines with a screen, use the external Chromium window.
  Helm has no browser panel.
  The window does not take keyboard control.
  Your actions wait while the owner uses the window.
  Use --engine bowser for Bowser Computer Use, if installed.
    look <tab>        Read page text and numbered elements without a screenshot.
    act <tab> <JSON>  Run actions: '{"actions":[{"click":"the Save button"},{"check":"Saved"}]}'
                      Use exact page text or targets for checks.
                      Kinds: click, type, goto, check, key, scroll, hover, select,
                      upload (with files), evaluate (page script), wait (CSS
                      selector), resize, dialog, console, network, back,
                      forward, reload; or
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
