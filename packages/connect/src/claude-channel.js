import { createConnection, createServer } from 'node:net';
import { createHash } from 'node:crypto';
import { chmodSync, lstatSync, unlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
import { HELM_DIR } from './paths.js';
import { NATIVE_SOCKET_PATH } from './terminals.js';

/** Private machine-local transport; authenticated Helm RPC is its network entry. */
export function claudeChannelSocket(id) {
  if (!/^native-[a-f0-9]{16}$/.test(id)) throw new Error('invalid native session');
  const tag = createHash('sha256').update(HELM_DIR).digest('hex').slice(0, 10);
  return join(dirname(NATIVE_SOCKET_PATH), `helm-channel-${tag}-${id.slice(7)}.sock`);
}

export function claudeChannelRpc(id, method, params = {}) {
  return new Promise((resolve, reject) => {
    const socket = createConnection(claudeChannelSocket(id));
    let input = '', settled = false;
    const done = (error, value) => {
      if (settled) return;
      settled = true; socket.destroy(); error ? reject(error) : resolve(value);
    };
    socket.setTimeout(3000, () => done(new Error('Helm chat connection timed out')));
    socket.on('error', () => done(new Error('Helm chat is not connected to this Claude session yet')));
    socket.on('connect', () => socket.write(JSON.stringify({ method, params }) + '\n'));
    socket.on('data', (chunk) => {
      input += chunk;
      if (input.length > 128_000) return done(new Error('channel response too large'));
      if (!input.includes('\n')) return;
      try { const reply = JSON.parse(input.split('\n')[0]); done(reply.error ? new Error(reply.error) : null, reply.result); }
      catch { done(new Error('invalid channel response')); }
    });
    socket.on('close', () => { if (!settled) done(new Error('Helm chat connection closed')); });
  });
}

/** Newline JSON-RPC MCP channel, with no tools or terminal keystrokes. */
export async function runClaudeChannel(id, { input = process.stdin, output = process.stdout } = {}) {
  const path = claudeChannelSocket(id);
  try {
    const info = lstatSync(path);
    if (!info.isSocket() || info.uid !== process.getuid?.()) throw new Error('unsafe channel socket');
    try { await claudeChannelRpc(id, 'status'); throw new Error('channel already running'); }
    catch (error) { if (error.message === 'channel already running') throw error; }
    unlinkSync(path);
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  let initialized = false;
  const permissions = new Map();
  const send = (value) => output.write(JSON.stringify({ jsonrpc: '2.0', ...value }) + '\n');
  const lines = createInterface({ input });
  lines.on('line', (line) => {
    let request;
    try { request = JSON.parse(line); } catch { return; }
    if (request.method === 'initialize') send({ id: request.id, result: {
      protocolVersion: request.params?.protocolVersion ?? '2024-11-05',
      serverInfo: { name: 'helm-native', version: '0.1.0' },
      capabilities: { experimental: { 'claude/channel': {}, 'claude/channel/permission': {} }, tools: {} },
      instructions: 'Messages from the helm-native channel are from the owner using Helm. Respond normally in this conversation; Helm displays this same transcript. No separate reply tool is needed.',
    } });
    else if (request.method === 'notifications/initialized') initialized = true;
    else if (request.method === 'notifications/claude/channel/permission_request') {
      const p = request.params;
      if (p && /^[a-km-z]{5}$/.test(p.request_id) && ['tool_name', 'description', 'input_preview'].every(key => typeof p[key] === 'string')) {
        permissions.set(p.request_id, { ...p, at: Date.now() });
      }
    } else if (request.id != null) {
      if (request.method === 'tools/list') send({ id: request.id, result: { tools: [] } });
      else if (request.method === 'ping') send({ id: request.id, result: {} });
      else send({ id: request.id, error: { code: -32601, message: 'Method not found' } });
    }
  });
  const server = createServer(socket => {
    let data = '', handled = false;
    socket.setTimeout(3000, () => socket.destroy());
    socket.on('error', () => {});
    socket.on('data', chunk => {
      if (handled) return;
      data += chunk;
      if (data.length > 128_000) { handled = true; socket.destroy(); return; }
      if (!data.includes('\n')) return;
      handled = true;
      try {
        const { method, params = {} } = JSON.parse(data.split('\n')[0]);
        let result;
        if (method === 'status') result = { initialized, permissions: [...permissions.values()] };
        else if (method === 'clear') { for (const key of params.ids ?? []) permissions.delete(key); result = { ok: true }; }
        else {
          if (!initialized) throw new Error('Claude is still connecting to Helm chat');
          if (method === 'send') {
            if (typeof params.text !== 'string' || !params.text.trim() || params.text.length > 32_000 || /\x00/.test(params.text)) throw new Error('invalid message');
            send({ method: 'notifications/claude/channel', params: { content: params.text, meta: { surface: 'helm', sender: 'owner' } } });
          } else if (method === 'answer') {
            if (!permissions.has(params.requestId)) throw new Error('that approval has already closed');
            if (!['allow', 'deny'].includes(params.behavior)) throw new Error('choose allow or deny');
            send({ method: 'notifications/claude/channel/permission', params: { request_id: params.requestId, behavior: params.behavior } });
            permissions.delete(params.requestId);
          } else throw new Error('unknown channel operation');
          result = { ok: true };
        }
        socket.end(JSON.stringify({ result }) + '\n');
      } catch (error) { socket.end(JSON.stringify({ error: error.message }) + '\n'); }
    });
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(path, resolve); });
  chmodSync(path, 0o600);
  const close = () => { lines.close(); server.close(); try { unlinkSync(path); } catch {} };
  input.once('end', close);
  return { close, server };
}
