// Whether the owner still has to see a helper's failure.
//
// A helper on another machine is marked seen in its lead's record of it
// (`remoteHelpers`), never in its own: reading its own mark kept a failure
// the owner had dismissed opening every time (2026-11-11).

type Delegation = { dismissedFailureAt?: number; finishedAt?: number };
type Remote = { id: string; dismissedFailureAt?: number; finishedAt?: number };

export function failureUnseen(helper: { id: string; delegation?: Delegation | null }, remote: Remote[] = []): boolean {
  const away = remote.find((record) => record.id === helper.id);
  if (away) return away.dismissedFailureAt !== (away.finishedAt ?? 0);
  return helper.delegation?.dismissedFailureAt !== (helper.delegation?.finishedAt ?? 0);
}
