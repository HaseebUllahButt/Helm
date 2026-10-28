/** A route is evidence of a path, not proof that the destination answers. */
export function connectionChecks(routes, { privateNames = false, now = Date.now(), machineIds } = {}) {
  return (routes?.machines ?? []).map((machine, i) => {
    const reached = !!(machine.attached || machine.url || machine.direct?.used);
    const number = machineIds ? machineIds.indexOf(machine.env) + 1 : i + 1;
    const name = privateNames ? number > 0 ? `Machine ${number}` : 'Unknown machine' : machine.name || `Machine ${i + 1}`;
    const age = Number.isFinite(machine.lastSeen) ? Math.max(0, Math.floor((now - machine.lastSeen) / 60000)) : null;
    const last = age === null ? 'No earlier connection is saved.' : age === 0 ? 'Its connection was seen less than a minute ago.'
      : `Its connection was seen ${age} minute${age === 1 ? '' : 's'} ago.`;
    const id = privateNames ? number > 0 ? `machine-${number}` : `check-${i + 1}` : `machine-${i + 1}`;
    return { id, state: reached ? 'ok' : 'warning',
      message: reached ? `${name} has a connection from here.` : `${name} has no connection from here. ${last}`,
      ...(!reached ? { action: 'Check that machine is awake and connected. Run helm doctor there.' } : {}) };
  });
}

/** Export only fixed fields and generated names. Never copy errors or addresses. */
export function connectionSupport(routes, now = Date.now(), machineIds) {
  const machines = Array.isArray(routes?.machines) ? routes.machines : [];
  const ids = machineIds ?? machines.map(machine => machine.env);
  const names = new Map(ids.map((id, i) => [id, `Machine ${i + 1}`]));
  return { checks: connectionChecks({ machines }, { privateNames: true, now, machineIds: ids }),
    history: (routes?.history ?? []).filter(event => names.has(event.env)
      && ['connected', 'disconnected', 'path-changed'].includes(event.state)
      && Number.isFinite(event.at) && event.at >= 0 && event.at <= now)
      .map(event => ({ machine: names.get(event.env), state: event.state, at: event.at })) };
}
