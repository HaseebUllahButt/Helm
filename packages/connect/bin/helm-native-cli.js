#!/usr/bin/env node
import { runNativeCli } from '../src/native-cli.js';
const [engine, executable, ...args] = process.argv.slice(2);
try {
  process.exitCode = await runNativeCli(engine, executable, args);
} catch (err) {
  console.error(`helm: ${err.message}`);
  process.exitCode = 1;
}
