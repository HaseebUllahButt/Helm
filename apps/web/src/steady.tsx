import { memo, useRef, type ComponentType } from 'react';

const sameList = (a: unknown, b: unknown) => Array.isArray(a) && Array.isArray(b)
  && a.length === b.length && a.every((item, i) => Object.is(item, b[i]));

/** Each prop is the same value, or both are lists of the same items. */
function sameProps(a: Record<string, unknown>, b: Record<string, unknown>) {
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length
    && keys.every((key) => Object.is(a[key], b[key]) || sameList(a[key], b[key]));
}

/**
 * A screen that draws again only when what it shows changes. The parent
 * makes new handlers (`onBack={() => …}`) and new lists on each of its own
 * redraws; here each handler is one function for the life of the screen,
 * which calls the parent's newest one, and a list with the same items is
 * the same list. A handler that comes or goes still redraws the screen.
 */
export function steady<P extends object>(Inner: ComponentType<P>) {
  const Kept = memo(Inner, sameProps as (a: Readonly<P>, b: Readonly<P>) => boolean);
  function Steady(props: P) {
    const latest = useRef(props);
    latest.current = props;
    const calls = useRef(new Map<string, (...args: unknown[]) => unknown>());
    const passed: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(props)) {
      if (typeof value !== 'function') { passed[key] = value; continue; }
      let call = calls.current.get(key);
      if (!call) {
        call = (...args) => (latest.current as Record<string, ((...args: unknown[]) => unknown) | undefined>)[key]?.(...args);
        calls.current.set(key, call);
      }
      passed[key] = call;
    }
    return <Kept {...(passed as any)} />;
  }
  Steady.displayName = `Steady(${Inner.displayName ?? Inner.name})`;
  return Steady;
}
