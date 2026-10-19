#!/usr/bin/env node
// Test-only fake agent for scripts/render-count.mjs: answers a prompt by
// streaming a long reply in small pieces (FAKE_STREAM_MS, default 18 s, one
// piece every FAKE_PIECE_MS, default 80 ms). Speaks the same small ACP subset
// as test/fake-agent.mjs.
if (process.argv.includes('--version')) { console.log('devin 3000.10.21'); process.exit(0); }
const total = Number(process.env.FAKE_STREAM_MS ?? 18000);
const every = Number(process.env.FAKE_PIECE_MS ?? 80);
const out = (m) => process.stdout.write(JSON.stringify(m) + '\n');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const WORDS = 'the quick brown fox jumps over a lazy dog while the render count stays low and the page stays calm'.split(' ');
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
    case 'session/new': return reply({ sessionId: 'fake-stream-1' });
    case 'session/load': case 'session/set_config_option': return reply({});
    case 'session/prompt': {
      const sid = m.params.sessionId;
      const end = Date.now() + total;
      for (let n = 0; Date.now() < end; n++) {
        // A paragraph break every 12 words, so the reply grows like real markdown.
        const text = WORDS[n % WORDS.length] + (n % 12 === 11 ? '.\n\n' : ' ');
        out({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: sid, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } } } });
        await sleep(every);
      }
      out({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: sid, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'done.' } } } });
      return reply({ stopReason: 'end_turn', usage: { inputTokens: 10, outputTokens: 5 } });
    }
    case 'session/cancel': return;
    default: if (m.id !== undefined) out({ jsonrpc: '2.0', id: m.id, error: { code: -32601, message: `no ${m.method}` } });
  }
}
