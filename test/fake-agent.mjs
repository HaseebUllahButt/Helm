#!/usr/bin/env node
// A minimal live ACP agent - not a recording. Unlike fake-cli.mjs it keeps
// state and takes its time, which is what a restart-survival test needs:
// the prompt's response can land after the daemon that asked is gone.
//
//   FAKE_TURN_MS=800 FAKE_ASK=1 node fake-agent.mjs
//
//   initialize / session/new / session/load / set_config_option  answered at once
//   session/prompt        emits one text chunk, waits FAKE_TURN_MS, then -
//                         with FAKE_ASK - holds the turn on a permission
//                         request until it is answered, and only then
//                         resolves the prompt with stopReason end_turn
//   stdin ending          exits, like a real CLI
if (process.argv.includes('--version')) {
  console.log('devin 3000.10.21');
  process.exit(0);
}

const delay = Number(process.env.FAKE_TURN_MS ?? 600);
const ask = process.env.FAKE_ASK === '1';
const out = (m) => process.stdout.write(JSON.stringify(m) + '\n');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const askReply = new Map();

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
  // A client's answer to our permission request - not a request itself.
  if (m.id !== undefined && !m.method) { askReply.get(String(m.id))?.(m); return; }
  if (!m.method) return;
  const reply = (result) => out({ jsonrpc: '2.0', id: m.id, result });
  switch (m.method) {
    case 'initialize':
      return reply({ protocolVersion: 1, agentCapabilities: { promptCapabilities: { image: false } } });
    case 'session/new':
      return reply({ sessionId: 'fake-session-1' });
    case 'session/load':
      return reply({});
    case 'session/set_config_option':
      return reply({});
    case 'session/prompt': {
      const sid = m.params.sessionId;
      out({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: sid, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'working on it ' } } } });
      await sleep(delay);
      if (ask) {
        const rid = `perm-${m.id}`;
        const answered = new Promise((resolve) => askReply.set(rid, resolve));
        out({ jsonrpc: '2.0', id: rid, method: 'session/request_permission', params: {
          sessionId: sid,
          toolCall: { toolCallId: 'call-1', title: 'Run a command', rawInput: { command: 'echo hi' } },
          options: [
            { optionId: 'allow_once', kind: 'allow_once', name: 'Allow' },
            { optionId: 'allow_always', kind: 'allow_always', name: 'Always allow' },
            { optionId: 'reject_once', kind: 'reject_once', name: 'Deny' },
          ],
        } });
        const res = await answered;
        const denied = res?.result?.outcome?.outcome === 'cancelled' || /reject/.test(res?.result?.outcome?.optionId ?? '');
        if (denied) return reply({ stopReason: 'cancelled' });
      }
      out({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: sid, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'done.' } } } });
      return reply({ stopReason: 'end_turn', usage: { inputTokens: 10, outputTokens: 5 } });
    }
    case 'session/cancel':
      return;
    default:
      if (m.id !== undefined) out({ jsonrpc: '2.0', id: m.id, error: { code: -32601, message: `no ${m.method}` } });
  }
}
