/** A route is evidence of a path, not proof that the destination answers. */
export function connectionChecks(routes, { privateNames = false, now = Date.now() } = {}) {
  return (routes?.machines ?? []).map((machine, i) => {
    const reached = !!(machine.attached || machine.url || machine.direct?.used);
    const name = privateNames ? `Machine ${i + 1}` : machine.name || `Machine ${i + 1}`;
    const age = Number.isFinite(machine.lastSeen) ? Math.max(0, Math.floor((now - machine.lastSeen) / 60000)) : null;
    const last = age === null ? 'No earlier connection is saved.' : age === 0 ? 'Its connection was seen less than a minute ago.'
      : `Its connection was seen ${age} minute${age === 1 ? '' : 's'} ago.`;
    return { id: `machine-${i + 1}`, state: reached ? 'ok' : 'warning',
      message: reached ? `${name} has a connection from here.` : `${name} has no connection from here. ${last}`,
      ...(!reached ? { action: 'Check that machine is awake and connected. Run helm doctor there.' } : {}) };
  });
}

/** Export only fixed fields and generated names. Never copy errors or addresses. */
export function connectionSupport(routes, now = Date.now()) {
  const machines = Array.isArray(routes?.machines) ? routes.machines : [];
  const names = new Map(machines.map((machine, i) => [machine.env, `Machine ${i + 1}`]));
  return { checks: connectionChecks({ machines }, { privateNames: true, now }),
    history: (routes?.history ?? []).filter(event => names.has(event.env)
      && ['connected', 'disconnected', 'path-changed'].includes(event.state)
      && Number.isFinite(event.at) && event.at >= 0 && event.at <= now)
      .map(event => ({ machine: names.get(event.env), state: event.state, at: event.at })) };
}
