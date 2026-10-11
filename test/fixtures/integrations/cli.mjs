#!/usr/bin/env node
import { readFileSync, writeFileSync, mkdirSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse, stringify } from 'smol-toml';
const [group, verb, ...args] = process.argv.slice(2);
const claude = process.env.CLAUDE_CONFIG_DIR;
const root = claude || process.env.CODEX_HOME;
mkdirSync(root, { recursive: true });
appendFileSync(join(root, 'calls.jsonl'), JSON.stringify({ group, verb, args, home: root, secret: process.env.MCP_CLIENT_SECRET }) + '\n');
if (args.includes('--help')) { console.log('login --no-browser'); process.exit(0); }
if (args.includes('failure')) { console.error(`API key ${process.env.FAILURE_SECRET}, supplied header ${process.env.HEADER_SECRET}`); process.exit(1); }
const file = join(root, claude ? '.claude.json' : 'config.toml');
let config; try { const text = readFileSync(file, 'utf8'); config = claude ? JSON.parse(text) : parse(text); } catch { config = {}; }
const option = (key) => args[args.indexOf(key) + 1];
const scope = args.includes('--scope') ? option('--scope') : 'user';
let projectFile;
if (claude && scope === 'project') { projectFile = join(process.cwd(), '.mcp.json'); try { config = JSON.parse(readFileSync(projectFile, 'utf8')); } catch { config = {}; } }
if (group === 'mcp') {
  let servers;
  if (claude && scope === 'local') { config.projects ??= {}; config.projects[process.cwd()] ??= {}; servers = config.projects[process.cwd()].mcpServers ??= {}; }
  else servers = config[claude ? 'mcpServers' : 'mcp_servers'] ??= {};
  let name;
  if (verb === 'remove') name = args[0];
  else if (claude) {
    const t = option('--transport');
    name = args[t === 'stdio' ? args.indexOf('--') - 1 : args.length - 2];
  } else name = args[0];
  if (verb === 'remove') delete servers[name];
  else if (verb === 'add') servers[name] = args.includes('--') ? { command: args[args.indexOf('--') + 1], args: args.slice(args.indexOf('--') + 2) } : { type: 'http', url: claude ? args.at(-1) : option('--url') };
} else if (group === 'plugin') {
  if (claude) {
    const pluginFile = join(root, 'plugins', 'installed_plugins.json'); mkdirSync(join(root, 'plugins'), { recursive: true });
    let registry; try { registry = JSON.parse(readFileSync(pluginFile, 'utf8')); } catch { registry = { plugins: {} }; }
    if (verb === 'install') registry.plugins[args[0]] = [{ scope, version: '1.0.0' }]; else delete registry.plugins[args[0]];
    writeFileSync(pluginFile, JSON.stringify(registry));
  } else { config.plugins ??= {}; if (verb === 'add') config.plugins[args[0]] = { enabled: true }; else delete config.plugins[args[0]]; }
}
writeFileSync(projectFile || file, claude ? JSON.stringify(config) : stringify(config));
