import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { retainAssets } from './retainAssets.mjs';

/**
 * Three chunks by intent, not by accident:
 *   - `react`, which changes only when the framework is upgraded, so a phone
 *     that has it keeps it across every helm deploy;
 *   - `md` and the terminal, which split themselves out through the dynamic
 *     imports in Markdown.tsx and App.tsx;
 *   - everything else, which is helm itself.
 * The point is the first paint: signing in and picking a machine should not
 * wait on a syntax highlighter or a terminal emulator.
 */
export default defineConfig({
  plugins: [react(), retainAssets()],
  server: { port: 5273 },
  build: {
    outDir: 'dist',
    // Keep open PWAs working during and after a deploy. The plugin expires
    // old hashed files after a week, once the new build has been written.
    emptyOutDir: false,
    sourcemap: true,
    rollupOptions: {
      output: { manualChunks: { react: ['react', 'react-dom', 'react-dom/client'] } },
    },
  },
});
