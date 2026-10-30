#!/usr/bin/env node
// Test-only fake agent for scripts/bench-stream/run.mjs. A prompt "w1" streams
// the W1 reply: delta i is written at start + i x 16 ms, on a fixed clock, so a
// slow tick never stretches the reply. The turn stays open HOLD_MS after the
// last delta, so the measured span ends before the reply is marked done (as in
// PandaCode's bench). Any other prompt gets a short reply. Speaks the same
// small ACP subset as test/fake-agent.mjs.
import { W1_DELTAS, DELTA_MS } from './workload.mjs';

if (process.argv.includes('--version')) { console.log('devin 3000.10.21'); process.exit(0); }
const HOLD_MS = Number(process.env.FAKE_HOLD_MS ?? 4000);
const out = (m) => process.stdout.write(JSON.stringify(m) + '\n');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i); buf = buf.slice(i + 1);
    if (line.trim()) onMessage(JSON.parse(line));
  }
});
process.stdin.on('end', () => setTimeout(() => process.exit(0), 50));
async function onMessage(m) {
  if (!m.method) return;
  const reply = (result) => out({ jsonrpc: '2.0', id: m.id, result });
  switch (m.method) {
    case 'initialize': return reply({ protocolVersion: 1, agentCapabilities: { promptCapabilities: { image: false } } });
    case 'session/new': return reply({ sessionId: `bench-${process.pid}` });
    case 'session/load': case 'session/set_config_option': return reply({});
    case 'session/prompt': {
      const sid = m.params.sessionId;
      const text = (t) => out({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: sid, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: t } } } });
      const prompt = (m.params.prompt ?? []).map((p) => p.text ?? '').join('').trim();
      if (!/^w1\b/.test(prompt)) { text('Ready for the stream.'); return reply({ stopReason: 'end_turn', usage: { inputTokens: 10, outputTokens: 5 } }); }
      const start = performance.now();
      for (let i = 0; i < W1_DELTAS.length; i++) {
        const wait = start + i * DELTA_MS - performance.now();
        if (wait > 0) await sleep(wait);
        text(W1_DELTAS[i]);
      }
      await sleep(HOLD_MS);
      return reply({ stopReason: 'end_turn', usage: { inputTokens: 10, outputTokens: 5 } });
    }
    case 'session/cancel': return;
    default: if (m.id !== undefined) out({ jsonrpc: '2.0', id: m.id, error: { code: -32601, message: `no ${m.method}` } });
  }
}
