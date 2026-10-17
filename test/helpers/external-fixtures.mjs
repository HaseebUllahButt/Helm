import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

// Outside-CLI history, with no real account or running provider behind it.
export function externalFixtures(root) {
  const cwd = join(root, 'work');
  mkdirSync(cwd, { recursive: true });
  const put = (path, records) => {
    mkdirSync(join(path, '..'), { recursive: true });
    writeFileSync(path, records.map(JSON.stringify).join('\n') + '\n');
  };
  const profiles = [];
  const rows = [];
  for (const engine of ['claude', 'codex', 'opencode', 'opencode2', 'pi']) {
    const home = join(root, 'home', `.${engine}`);
    const id = `${engine}-outside-history`;
    const user = `Continue ${engine} work`;
    const answer = `Saved ${engine} answer`;
    const envName = { claude: 'CLAUDE_CONFIG_DIR', codex: 'CODEX_HOME', opencode: 'XDG_CONFIG_HOME', opencode2: 'XDG_CONFIG_HOME', pi: 'PI_CODING_AGENT_DIR' }[engine];
    profiles.push({ id: engine, label: engine, engine, cmd: engine, args: [], env: { [envName]: home }, source: 'custom' });
    let path;
    if (engine === 'claude') {
      path = join(home, 'projects', '-outside', `${id}.jsonl`);
      put(path, [
        { type: 'user', uuid: 'u', cwd, message: { role: 'user', content: user } },
        { type: 'assistant', uuid: 'a', message: { role: 'assistant', model: 'model-a', content: [{ type: 'text', text: answer }] } },
      ]);
    } else if (engine === 'codex') {
      path = join(home, 'sessions', `rollout-${id}.jsonl`);
      put(path, [
        { type: 'session_meta', payload: { id, cwd } },
        { type: 'turn_context', payload: { model: 'model-a', effort: 'high' } },
        ...[['user', user], ['assistant', answer]].map(([role, text]) => ({ type: 'response_item', payload: { type: 'message', role, channel: 'final', content: [{ type: role === 'user' ? 'input_text' : 'output_text', text }] } })),
      ]);
    } else if (engine === 'pi') {
      path = join(home, 'sessions', '--outside--', `${id}.jsonl`);
      put(path, [
        { type: 'session', version: 3, id, cwd },
        { type: 'model_change', provider: 'test', modelId: 'model-a' },
        { type: 'thinking_level_change', thinkingLevel: 'high' },
        ...[['user', user], ['assistant', answer]].map(([role, text]) => ({ type: 'message', message: { role, content: [{ type: 'text', text }] } })),
      ]);
    } else {
      path = join(root, 'home', '.local', 'share', 'opencode', 'opencode.db');
      mkdirSync(join(path, '..'), { recursive: true });
      const db = new DatabaseSync(path);
      db.exec(`CREATE TABLE IF NOT EXISTS session (id TEXT PRIMARY KEY, title TEXT, directory TEXT, time_updated INTEGER, agent TEXT, model TEXT);
        CREATE TABLE IF NOT EXISTS message (id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, data TEXT);
        CREATE TABLE IF NOT EXISTS part (id TEXT PRIMARY KEY, message_id TEXT, time_created INTEGER, data TEXT);`);
      if (engine === 'opencode2') {
        db.exec(`CREATE TABLE session_v2 (id TEXT PRIMARY KEY, title TEXT, directory TEXT, time_updated INTEGER, agent TEXT, model TEXT);
          CREATE TABLE session_message (id TEXT PRIMARY KEY, session_id TEXT, type TEXT, data TEXT, time_created INTEGER, seq INTEGER);`);
      }
      db.prepare(`INSERT INTO ${engine === 'opencode2' ? 'session_v2' : 'session'} VALUES (?, ?, ?, ?, ?, ?)`).run(id, user, cwd, Date.now(), 'build', 'model-a');
      for (const [i, role, text] of [[1, 'user', user], [2, 'assistant', answer]]) {
        if (engine === 'opencode2') db.prepare('INSERT INTO session_message VALUES (?, ?, ?, ?, ?, ?)').run(String(i), id, role, JSON.stringify({ role, content: [{ type: 'text', text }] }), i, i);
        else {
          db.prepare('INSERT INTO message VALUES (?, ?, ?, ?)').run(String(i), id, i, JSON.stringify({ role }));
          db.prepare('INSERT INTO part VALUES (?, ?, ?, ?)').run(String(i), String(i), i, JSON.stringify({ type: 'text', text }));
        }
      }
      db.close();
    }
    rows.push({ engine, id, cwd, path, user, answer });
  }
  return { profiles, rows };
}
