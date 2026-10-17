import { randomBytes } from 'node:crypto';
import { parseAgentArgs } from './delegation.js';

/** CLI messages inherit a real sender; ordinary owner prompts keep the old say path. */
export async function runMessageCommand(command, args, { rpc, self, findSession,
  senderId = process.env.HELM_SESSION_ID, callerThreadId = process.env.CODEX_THREAD_ID, write = console.log } = {}) {
  const { options, words } = parseAgentArgs(args, { values: ['message-id'], switches: ['json'] });
  if (command === 'messages') {
    if (words.length > 1 || (!words[0] && !senderId)) throw new Error('helm messages <chat-id> [--json]');
    const target = words[0] ? await findSession(words[0]) : { env: self, session: { id: senderId } };
    const result = await rpc(target.env, 'session.agent-messages', { id: target.session.id });
    if (options.json) write(JSON.stringify(result));
    else {
      for (const m of result.messages.toReversed()) write(`${m.id}  ${m.asUser ? 'You' : m.from.title} → ${m.to.title} (${m.status})${m.replyTo ? ` · reply to ${m.replyTo}` : ''}\n${m.text}`);
      if (!result.messages.length) write('No agent messages yet.');
      if (result.next) write('Showing the latest messages. Older exchanges are in the Agents panel.');
    }
    return;
  }
  if (!senderId) throw new Error('Agent replies run inside a Helm chat. Use helm say <chat-id> <text> for an owner prompt.');
  const [target, ...parts] = words;
  const text = parts.join(' ');
  if (!target || !text.trim()) throw new Error(`helm ${command} <${command === 'reply' ? 'message' : 'chat'}-id> [--message-id <id>] -- "text"`);
  const messageId = options['message-id'] ?? randomBytes(16).toString('hex');
  let to;
  if (command !== 'reply') {
    const found = await findSession(target);
    to = { env: found.env, id: found.session.id };
  }
  let result;
  try { result = await rpc(self, 'session.agent-send', { id: senderId, to, text, messageId,
    ...(command === 'reply' ? { replyTo: target } : {}), ...(callerThreadId ? { callerThreadId } : {}) }, 70_000); }
  catch (error) { throw new Error(`${error.message}\nRetry this same message with: helm ${command} ${target} --message-id ${messageId} -- <same text>`); }
  write(options.json ? JSON.stringify(result) : `Message ${messageId} delivered to ${result.message.to.title}. It will be read at the next turn.`);
}
