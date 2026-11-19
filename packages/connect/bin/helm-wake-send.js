import { sendWake } from '../src/wake-machine.js';

try {
  await sendWake(process.argv[2]);
} catch (error) {
  process.stderr.write(error.message + '\n');
  process.exitCode = 1;
}
