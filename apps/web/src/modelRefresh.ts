/**
 * Show the usable catalog immediately, then follow its background refresh.
 * The follow-up asks with `settled`: the machine answers once its refresh is
 * done, so one more request replaces a poll every second. A machine too old
 * to wait answers at once, and the delay keeps that a poll.
 * A list that stays open checks again after the machine cache expires.
 */
export function followModelRefresh<T extends { refreshing?: boolean }>(
  fetchList: (settled: boolean) => Promise<T>,
  receive: (list: T) => void,
  onError: (error: unknown) => void,
  delayMs = 1000,
) {
  let stopped = false;
  let pending = false;
  let refreshing = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const refresh = async (settled = false) => {
    if (stopped || pending) return;
    clearTimeout(timer);
    pending = true;
    try {
      const list = await fetchList(settled);
      if (stopped) return;
      refreshing = !!list.refreshing;
      receive(list);
      timer = setTimeout(() => refresh(refreshing), refreshing ? delayMs : 10 * 60_000 + 1000);
    } catch (error) {
      if (!stopped) {
        onError(error);
        // A lost follow-up must not leave an open menu on the old list.
        timer = setTimeout(() => refresh(refreshing), refreshing ? delayMs : 10 * 60_000 + 1000);
      }
    } finally {
      pending = false;
    }
  };
  void refresh();
  return { refresh: () => refresh(), stop: () => { stopped = true; clearTimeout(timer); } };
}
