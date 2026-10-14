import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { join } from 'node:path';
import { expand } from './paths.js';

// Claude uses task frames for both helpers and background services. A shell
// command or a passive watch does not keep the conversation working.
const SERVICE_TYPES = new Set(['local_bash', 'monitor_mcp', 'monitor_ws']);
const SERVICE_TOOLS = new Set(['Bash', 'Monitor', 'Artifact']);

export const nonAgentClaudeTask = (task) => SERVICE_TYPES.has(task?.type)
  || task?.ambient === true || task?.skipTranscript === true
  || task?.kind === 'command' || SERVICE_TOOLS.has(task?.name)
  || /^Background command ["“]/.test(task?.summary ?? '');

/** Recover just the missing task classifications from the exact CLI transcript. */
export async function claudeServiceTasks({ home, cwd, sessionId, ids }) {
  if (!cwd || !/^[a-f0-9-]{36}$/i.test(sessionId ?? '') || !ids.length) return [];
  const wanted = new Set(ids), services = [];
  const path = join(expand(home), 'projects', expand(cwd).replace(/\//g, '-'), `${sessionId}.jsonl`);
  const input = createReadStream(path, { encoding: 'utf8' });
  const lines = createInterface({ input, crlfDelay: Infinity });
  try {
    for await (const line of lines) {
      if (![...wanted].some(id => line.includes(id))) continue;
      let record;
      try { record = JSON.parse(line); } catch { continue; }
      const content = record.message?.content;
      for (const block of Array.isArray(content) ? content : []) {
        if (!block || block.type !== 'tool_use' || !wanted.has(block.id)) continue;
        wanted.delete(block.id);
        if (nonAgentClaudeTask(block)) services.push(block.id);
      }
      if (!wanted.size) break;
    }
  } catch { /* unavailable transcript: preserve the alert until it is reviewed */ }
  finally { lines.close(); input.destroy(); }
  return services;
}
