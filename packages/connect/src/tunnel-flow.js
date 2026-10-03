/** End-to-end credit, so a fast sender cannot fill a slow peer's hub socket. */
export const TUNNEL_WINDOW = 512 * 1024;
export const TUNNEL_CHUNK = 64 * 1024;

export class TunnelSender {
  sent = 0;
  acknowledged = 0;
  pending = null;
  stopped = false;
  finishing = null;

  constructor(input, send, fail) {
    this.input = input;
    this.send = send;
    this.fail = fail;
    this.data = chunk => {
      input.pause();
      this.pending = Buffer.from(chunk);
      this.pump();
    };
    input.on('data', this.data);
    input.resume();
  }

  pump() {
    if (this.stopped) return;
    while (this.pending?.length && this.sent - this.acknowledged < TUNNEL_WINDOW) {
      const size = Math.min(this.pending.length, TUNNEL_CHUNK, TUNNEL_WINDOW - this.sent + this.acknowledged);
      const chunk = this.pending.subarray(0, size);
      this.pending = this.pending.subarray(size);
      this.sent += size;
      try { this.send(chunk); } catch (err) { this.fail(err); return; }
    }
    if (!this.pending?.length) {
      this.pending = null;
      if (this.finishing && this.sent === this.acknowledged) {
        const done = this.finishing;
        this.stop();
        done();
      } else if (!this.finishing && this.sent - this.acknowledged < TUNNEL_WINDOW) this.input.resume();
    }
  }

  // A TCP FIN can arrive while the last chunk is still waiting for credit.
  // Do not send tunnel CLOSE until that tail has reached the other writer.
  finish(done) {
    if (this.stopped) return done();
    this.finishing = done;
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
    this.input.pause();
    this.input.off('data', this.data);
    this.pending = null;
  }
}

export class TunnelReceiver {
  received = 0;
  acknowledged = 0;
  stopped = false;

  constructor(output, acknowledge, fail) {
    this.output = output;
    this.acknowledge = acknowledge;
    this.fail = fail;
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
        || this.received - this.acknowledged + chunk.length > TUNNEL_WINDOW) {
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
