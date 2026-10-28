import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

/**
 * Closes the Helm app window on this desktop, for its Close button
 * (windowClose.ts). Chromium lets a page close a window it did not open only
 * while the window has one history entry, and Helm adds one for each screen,
 * so the page asks here instead. SIGTERM is how Chromium quits on its own: it
 * saves what it keeps and exits. Returns how many browsers were told to quit.
 */
export function closeAppWindow(profile = join(process.env.HELM_DIR || join(homedir(), '.helm'), 'app-window')) {
  if (process.platform !== 'linux') return 0;
  const want = `--user-data-dir=${profile}`;
  let pids = [];
  try { pids = readdirSync('/proc').filter((name) => /^\d+$/.test(name)); } catch { return 0; }
  let closed = 0;
  for (const pid of pids) {
    // Chromium rewrites its own command line into one line with spaces, so
    // match on words of that line rather than on separate arguments.
    let line;
    try { line = ` ${readFileSync(join('/proc', pid, 'cmdline'), 'utf8').replace(/\0/g, ' ')} `; } catch { continue; }
    // The browser itself: the window's profile, and none of a helper process's --type=.
    if (!line.includes(` ${want} `) || line.includes(' --type=')) continue;
    try { process.kill(Number(pid), 'SIGTERM'); closed += 1; } catch { /* already gone */ }
  }
  return closed;
}
