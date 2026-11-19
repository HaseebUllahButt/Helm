/**
 * Cards Helm asks itself, not the agent: helm sudo (sudo.js) and helm phone
 * (phone.js). Sessions keeps one `helmAsks`; this joins the owners, and
 * each one claims its own request ids with `owns`.
 */
export function joinHelmAsks(...owners) {
  const list = owners.filter(Boolean);
  const owner = (requestId) => list.find((o) => o.owns(requestId));
  return {
    owners: list,
    owns: (requestId) => !!owner(requestId),
    answer: (id, requestId, decision) => owner(requestId).answer(id, requestId, decision),
    stop: () => { for (const o of list) o.stop?.(); },
  };
}
