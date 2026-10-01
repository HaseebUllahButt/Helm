/** Show the usable catalog immediately, then follow its background refresh. */
export function followModelRefresh<T extends { refreshing?: boolean }>(
  fetchList: () => Promise<T>,
  receive: (list: T) => void,
  onError: (error: unknown) => void,
  delayMs = 1000,
) {
  let stopped = false;
  let pending = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const refresh = async () => {
    if (stopped || pending) return;
    clearTimeout(timer);
    pending = true;
    try {
      const list = await fetchList();
      if (stopped) return;
      receive(list);
      if (list.refreshing) timer = setTimeout(refresh, delayMs);
    } catch (error) {
      if (!stopped) onError(error);
    } finally {
      pending = false;
    }
  };
  void refresh();
  return { refresh, stop: () => { stopped = true; clearTimeout(timer); } };
}
