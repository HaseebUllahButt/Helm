import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';

// Claude's `/context` answer, read back into the numbers its card draws.
const bundle = await build({ entryPoints: ['apps/web/src/session/contextUsage.ts'], bundle: true, write: false, format: 'esm', platform: 'browser' });
const { parseContextUsage } = await import('data:text/javascript;base64,' + Buffer.from(bundle.outputFiles[0].text).toString('base64'));

// Recorded from Claude Code 2.1.296, trimmed.
const RECORDED = `## Context Usage

**Model:** claude-opus-5-5  
**Tokens:** 28.3k / 383k (7%)

### Estimated usage by category

| Category | Tokens | Percentage |
|----------|--------|------------|
| System prompt | 2.1k | 0.5% |
| System tools | 23.8k | 6.2% |
| System tools (deferred) | 29.8k | 7.8% |
| Memory files | 87 | 0.0% |
| Skills | 2.3k | 0.6% |
| Free space | 321.7k | 84.0% |
| Autocompact buffer | 33k | 8.6% |

### Memory Files

| Type | Path | Tokens |
|------|------|--------|
| User | /home/x/.claude/CLAUDE.md | 87 |

### Skills

| Skill | Source | Tokens |
|-------|--------|--------|
| dataviz | Built-in | ~480 |
| loop | Built-in | ~120 |
`;

test('the /context answer becomes a total, a part per category and the lists behind it', () => {
  const u = parseContextUsage(RECORDED);
  assert.equal(u.model, 'claude-opus-5-5');
  assert.deepEqual([u.used, u.size, u.pct], ['28.3k', '383k', 7]);
  assert.deepEqual(u.parts.map((p) => [p.name, p.kind]), [
    ['System prompt', 'used'], ['System tools', 'used'], ['System tools (deferred)', 'unloaded'],
    ['Memory files', 'used'], ['Skills', 'used'], ['Free space', 'free'], ['Autocompact buffer', 'reserved'],
  ]);
  assert.equal(u.parts[1].pct, 6.2);
  assert.deepEqual(u.sections.map((s) => [s.title, s.rows]), [['Memory Files', 1], ['Skills', 2]]);
});

test('anything else a command prints is left as text', () => {
  assert.equal(parseContextUsage('Total cost: $0.00'), null);
  assert.equal(parseContextUsage('## Context Usage\n\nsomething new'), null);
});
