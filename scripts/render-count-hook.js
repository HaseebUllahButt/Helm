// Installed before the app loads (verify-helm open --init). Per React
// component name it counts renders (fibers that rendered in a commit) and
// mounts (first render), and sorts every commit by what caused it: a socket
// frame (by kind: session.update, session.event, ...), a key or click, or
// neither (timers and clocks).
(() => {
  const PERFORMED_WORK = 1;
  // Function (0), class (1), forwardRef (11) and simple memo (15) fibers.
  const NAMED = new Set([0, 1, 11, 15]);
  const fresh = () => ({ commits: 0, renders: Object.create(null), mounts: Object.create(null), causes: Object.create(null), frames: Object.create(null) });
  let s = fresh();
  let lastFrame = { at: 0, kind: '' }, lastInput = 0;
  const nameOf = (f) => {
    const t = f.type;
    if (!t) return 'Unknown';
    if (typeof t === 'function') return t.displayName || t.name || 'Anonymous';
    return t.displayName || t.render?.displayName || t.render?.name || t.type?.name || 'Anonymous';
  };
  const count = (f, into, mounted) => {
    if (!NAMED.has(f.tag)) return;
    const n = nameOf(f);
    into.renders[n] = (into.renders[n] || 0) + 1;
    if (mounted) into.mounts[n] = (into.mounts[n] || 0) + 1;
    into.commitRenders[n] = (into.commitRenders[n] || 0) + 1;
  };
  // A new fiber: it and everything under it rendered.
  const mount = (f, into) => {
    for (; f; f = f.sibling) { count(f, into, true); mount(f.child, into); }
  };
  // React reuses a skipped subtree as it is, so its fibers keep the
  // PerformedWork flag from whenever they last rendered: walking the whole
  // tree counts them every commit. Walk only where the children were rebuilt
  // in this commit, as React DevTools does; a fiber cloned there but skipped
  // has the flag cleared.
  const update = (next, prev, into) => {
    if (NAMED.has(next.tag) && (next.flags & PERFORMED_WORK)) count(next, into, false);
    if (next.child === prev.child) return;
    for (let c = next.child; c; c = c.sibling) {
      if (c.alternate) update(c, c.alternate, into);
      else { count(c, into, true); mount(c.child, into); }
    }
  };
  const hook = {
    supportsFiber: true, renderers: new Map(), isDisabled: false,
    inject(r) { const id = this.renderers.size + 1; this.renderers.set(id, r); return id; },
    onCommitFiberRoot(_id, root) {
      const now = performance.now();
      const cause = now - lastFrame.at < 150 ? lastFrame.kind : now - lastInput < 150 ? 'input' : 'clock-or-other';
      s.commits++;
      const c = s.causes[cause] ||= { commits: 0, renders: 0, byName: Object.create(null) };
      c.commits++;
      const scratch = { renders: s.renders, mounts: s.mounts, commitRenders: Object.create(null) };
      const next = root.current, prev = next.alternate;
      if (prev?.memoizedState?.element) update(next, prev, scratch); else mount(next.child, scratch);
      for (const [n, k] of Object.entries(scratch.commitRenders)) { c.renders += k; c.byName[n] = (c.byName[n] || 0) + k; }
    },
    onCommitFiberUnmount() {}, onPostCommitFiberRoot() {}, checkDCE() {}, onScheduleFiberRoot() {},
  };
  Object.defineProperty(window, '__REACT_DEVTOOLS_GLOBAL_HOOK__', { value: hook, configurable: true });

  // Count socket frames by kind. Nothing is changed for the app.
  const Native = window.WebSocket;
  window.WebSocket = class extends Native {
    constructor(...a) {
      super(...a);
      this.addEventListener('message', (ev) => {
        if (typeof ev.data !== 'string') return;
        let kind = 'other';
        try { const m = JSON.parse(ev.data); kind = m.t === 'event' ? (m.kind || 'event') : (m.t || 'other'); } catch { /* not JSON */ }
        if (kind === 'ping') return;
        s.frames[kind] = (s.frames[kind] || 0) + 1;
        lastFrame = { at: performance.now(), kind };
      });
    }
  };
  for (const t of ['keydown', 'pointerdown', 'click', 'input']) addEventListener(t, () => { lastInput = performance.now(); }, true);

  window.__renders = {
    reset() { s = fresh(); },
    read() { return JSON.parse(JSON.stringify(s)); },
  };
})();
