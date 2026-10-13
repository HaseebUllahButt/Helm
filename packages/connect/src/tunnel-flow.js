/** End-to-end credit, so a fast sender cannot fill a slow peer's hub socket. */
export const TUNNEL_WINDOW = 512 * 1024;
export const TUNNEL_CHUNK = 64 * 1024;
// Leave room for chat and control frames on the same machine connection.
export const TUNNEL_SOCKET_LIMIT = 256 * 1024;
/** Copies run long and far; a bigger window keeps a high-latency link full. */
export const COPY_WINDOW = 16 * 1024 * 1024;

export class TunnelSender {
  sent = 0;
  acknowledged = 0;
  pending = null;
  stopped = false;
  finishing = null;
  finishTimer = null;
  pumping = false;
  pumpTimer = null;
  pumpDelayed = false;
  burst = 0;

  constructor(input, send, fail, { window = TUNNEL_WINDOW, canSend } = {}) {
    this.input = input;
    this.send = send;
    this.fail = fail;
    this.window = window;
    this.canSend = canSend;
    this.data = chunk => {
      input.pause();
      this.pending = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      this.pump();
    };
    input.on('data', this.data);
    input.resume();
  }

  pump() {
    if (this.stopped || this.pumping || this.pumpTimer) return;
    this.pumping = true;
    try { this.flush(); } finally { this.pumping = false; }
  }

  later(delay) {
    if (this.pumpTimer || this.stopped) return;
    const resume = () => { this.pumpTimer = null; this.burst = 0; this.pump(); };
    this.pumpTimer = delay ? setTimeout(resume, delay) : setImmediate(resume);
    this.pumpTimer.unref?.();
    this.pumpDelayed = !!delay;
  }

  flush() {
    while (this.pending?.length && this.sent - this.acknowledged < this.window) {
      // Credit bounds each stream. This also bounds the shared socket queue,
      // and yields between bursts so a busy stream cannot monopolize a turn.
      if (this.canSend && !this.canSend()) { this.later(5); return; }
      if (this.canSend && this.burst === 2) { this.later(0); return; }
      const size = Math.min(this.pending.length, TUNNEL_CHUNK, this.window - this.sent + this.acknowledged);
      const chunk = this.pending.subarray(0, size);
      this.pending = this.pending.subarray(size);
      this.sent += size;
      this.burst++;
      try { this.send(chunk); } catch (err) { this.fail(err); return; }
      if (this.stopped) return;
    }
    if (!this.pending?.length) {
      this.pending = null;
      if (this.finishing && this.sent === this.acknowledged) {
        const done = this.finishing;
        this.stop();
        done();
      } else if (!this.finishing && this.sent - this.acknowledged < this.window) this.input.resume();
    }
  }

  // A TCP FIN can arrive while the last chunk is still waiting for credit.
  // Do not send tunnel CLOSE until that tail has reached the other writer.
  finish(done, { timeout = 30_000 } = {}) {
    if (this.stopped) return done();
    this.finishing = done;
    if (!this.finishTimer) {
      this.finishTimer = setTimeout(() => {
        this.stop();
        this.fail(new Error('tunnel close acknowledgement timed out'));
      }, timeout);
      this.finishTimer.unref?.();
    }
    this.pump();
  }

  ack(bytes) {
    if (this.stopped) return;
    if (!Number.isSafeInteger(bytes) || bytes < this.acknowledged || bytes > this.sent) {
      this.fail(new Error('invalid tunnel acknowledgement'));
      return;
    }
    this.acknowledged = bytes;
    this.pump();
  }

  stop() {
    this.stopped = true;
    this.finishing = null;
    clearTimeout(this.finishTimer);
    this.finishTimer = null;
    if (this.pumpDelayed) clearTimeout(this.pumpTimer);
    else clearImmediate(this.pumpTimer);
    this.pumpTimer = null;
    this.input.pause();
    this.input.off('data', this.data);
    this.pending = null;
  }
}

export class TunnelReceiver {
  received = 0;
  acknowledged = 0;
  stopped = false;

  constructor(output, acknowledge, fail, { window = TUNNEL_WINDOW } = {}) {
    this.output = output;
    this.acknowledge = acknowledge;
    this.fail = fail;
    this.window = window;
  }

  write(data) {
    if (this.stopped) return;
    if (typeof data !== 'string' || data.length > Math.ceil(TUNNEL_CHUNK / 3) * 4
        || !/^[A-Za-z0-9+/]*={0,2}$/.test(data)) {
      this.fail(new Error('invalid tunnel data'));
      return;
    }
    const chunk = Buffer.from(data, 'base64');
    if (!chunk.length || chunk.length > TUNNEL_CHUNK
        || this.received - this.acknowledged + chunk.length > this.window) {
      this.fail(new Error('tunnel receive window exceeded'));
      return;
    }
    this.received += chunk.length;
    this.output.write(chunk, err => {
      if (this.stopped) return;
      if (err) {
        // Writable emits error after invoking this callback. Failure cleanup
        // may already remove its listener (SSH has closed its read end).
        this.output.once?.('error', () => {});
        this.fail(err);
        return;
      }
      this.acknowledged += chunk.length;
      this.acknowledge(this.acknowledged);
    });
  }

  stop() { this.stopped = true; }
}
