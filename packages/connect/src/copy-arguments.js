import { Transform } from 'node:stream';
import { resolve } from 'node:path';
import { homedir } from 'node:os';

const MAX_ARGUMENT_BYTES = 8192;
const homePath = (path, home) => resolve(home, path === '~' ? '.' : path.startsWith('~/') ? path.slice(2) : path);

/**
 * With -s, rsync reads options and its destination from the byte stream.
 * Check that list before rsync can act on it. The signed folder alone does
 * not constrain an unchecked protected-argument stream.
 */
export class CopyArguments extends Transform {
  constructor(targetFolder, { home = homedir(), sendJobId = null } = {}) {
    super();
    this.target = homePath(targetFolder, home);
    this.home = home;
    // A Send job (send-engine.js) adds its own options. Its partial folder
    // carries the job id, and it prunes only its private stage, never a
    // folder it sends to again.
    this.sendJobId = sendJobId;
    this.stage = !!sendJobId && this.target.endsWith(`.helm-partial-${sendJobId}`);
    this.pending = Buffer.alloc(0);
    this.checked = false;
  }

  _transform(chunk, _encoding, done) {
    if (this.checked) { this.push(chunk); done(); return; }
    try {
      const bytes = Buffer.concat([this.pending, chunk]);
      const end = bytes.indexOf('\0\0');
      if ((end < 0 ? bytes.length : end + 2) > MAX_ARGUMENT_BYTES) throw new Error('The copy options are too large.');
      if (end < 0) { this.pending = bytes; done(); return; }
      const args = bytes.subarray(0, end).toString('utf8').split('\0');
      if (args.shift() !== 'rsync') throw new Error('The copy options are invalid.');
      // Accept only the options Helm's copy command emits. In particular,
      // no log file, backup path, remote file list, or command may be added.
      while (args.length && args[0] !== '.') {
        const arg = args.shift();
        if (['--stats', '--mkpath', '--from0'].includes(arg)) continue;
        // --bwlimit only slows the copy down; tests use it to watch a send in progress.
        if (/^--(?:compress-level|timeout|bwlimit)=\d{1,6}$/.test(arg)) continue;
        if (arg === '--partial-dir' && args[0] === '.helm-transfer-partial') { args.shift(); continue; }
        if (this.sendJobId) {
          if (['--checksum-choice=xxh128', '--compress-choice=zstd', '--delay-updates'].includes(arg)) continue;
          if (this.stage && ['--delete-delay', '--delete-excluded'].includes(arg)) continue;
          if (arg === '--partial-dir' && args[0] === `.helm-partial-${this.sendJobId}`) { args.shift(); continue; }
        }
        throw new Error(`The copy option ${arg.slice(0, 80)} is not supported.`);
      }
      if (args.length !== 2 || args[0] !== '.' || !args[1]
          || homePath(args[1], this.home) !== this.target) {
        throw new Error('The copy folder does not match the requested folder.');
      }
      this.checked = true;
      this.pending = null;
      // Send the canonical signed path, not a path whose '..' components
      // could cross a symlink before reaching the same lexical name.
      const fields = bytes.subarray(0, end).toString('utf8').split('\0');
      fields[fields.length - 1] = this.target.endsWith('/') ? this.target : `${this.target}/`;
      this.push(Buffer.concat([Buffer.from(`${fields.join('\0')}\0\0`), bytes.subarray(end + 2)]));
      done();
    } catch (error) { done(error); }
  }

  _flush(done) {
    done(this.checked ? null : new Error('The copy options did not arrive in full.'));
  }
}
