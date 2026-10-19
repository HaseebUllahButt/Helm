// Installed before the app loads (verify-helm open --init). Counts, per React
// component name, how many fibers did work in each commit.
(() => {
  const counts = Object.create(null);
  let commits = 0;
  const PERFORMED_WORK = 1;
  // Function (0), class (1), forwardRef (11) and simple memo (15) fibers.
  const NAMED = new Set([0, 1, 11, 15]);
  const nameOf = (f) => {
    const t = f.type;
    if (!t) return 'Unknown';
    if (typeof t === 'function') return t.displayName || t.name || 'Anonymous';
    return t.displayName || t.render?.displayName || t.render?.name || t.type?.name || 'Anonymous';
  };
  const walk = (f) => {
    while (f) {
      if (NAMED.has(f.tag) && (f.flags & PERFORMED_WORK)) {
        const n = nameOf(f);
        counts[n] = (counts[n] || 0) + 1;
      }
      if (f.child) walk(f.child);
      f = f.sibling;
    }
  };
  const hook = {
    supportsFiber: true, renderers: new Map(), isDisabled: false,
    inject(r) { const id = this.renderers.size + 1; this.renderers.set(id, r); return id; },
    onCommitFiberRoot(_id, root) { commits++; walk(root.current.child); },
    onCommitFiberUnmount() {}, onPostCommitFiberRoot() {}, checkDCE() {}, onScheduleFiberRoot() {},
  };
  Object.defineProperty(window, '__REACT_DEVTOOLS_GLOBAL_HOOK__', { value: hook, configurable: true });
  window.__renders = {
    reset() { for (const k of Object.keys(counts)) delete counts[k]; commits = 0; },
    read() { return { commits, counts: { ...counts } }; },
  };
})();
