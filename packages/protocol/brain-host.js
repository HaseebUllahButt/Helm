/** One network brain, on the VM. Presence never changes its home. */
export function brainHost(machines) {
  const all = Array.isArray(machines) ? machines : Object.values(machines ?? {});
  const ordered = [...all].sort((a, b) => String(a.id).localeCompare(String(b.id)));
  // Older networks have no kinds. The named VM still has a stable identity.
  return ordered.find(m => String(m.name).toLowerCase() === 'vm')
    ?? ordered.find(m => m.kind === 'vm')
    ?? null;
}
