import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { createRequire } from 'node:module';

const require = createRequire(new URL('../apps/web/package.json', import.meta.url));
const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');
const bundle = await build({ entryPoints: ['apps/web/src/EngineMark.tsx'], bundle: true, write: false, format: 'cjs', external: ['react', 'react/jsx-runtime'] });
const mod = { exports: {} };
new Function('module', 'exports', 'require', bundle.outputFiles[0].text)(mod, mod.exports, require);
const { EngineMark } = mod.exports;
const draw = (engine) => renderToStaticMarkup(React.createElement(EngineMark, { engine }));

test('a helper with an empty or odd agent name still gets a mark', () => {
  for (const engine of ['', undefined, null, 42, { name: 'x' }]) assert.match(draw(engine), /title="agent">·</);
});

test('an unknown agent gets its first letter', () => {
  assert.match(draw('Zed'), /title="Zed">z</);
});
