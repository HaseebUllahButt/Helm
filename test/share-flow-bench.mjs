// Run in the heavy slot. HELM_FLOW_REPO can point at an untouched worktree
// to measure the same loopback share before the flow-control change.
import { setup, download, cleanupState } from './share-flow-fixture.mjs';
const runs = Number(process.env.HELM_FLOW_RUNS || 3);
try {
  for (let run = 1; run <= runs; run++) {
    const fixture = await setup({ bytes: 50 * 1024 * 1024 });
    const initialRss = process.memoryUsage().rss;
    let peakRss = initialRss;
    const sample = setInterval(() => { peakRss = Math.max(peakRss, process.memoryUsage().rss); }, 2);
    const start = performance.now();
    try {
      await download(fixture, { hold: 350, delay: 3 });
      console.log(JSON.stringify({ run, milliseconds: Math.round(performance.now() - start),
        peakRssDelta: peakRss - initialRss, ...fixture.metrics }));
    } finally { clearInterval(sample); await fixture.close(); }
  }
} finally { cleanupState(); }
