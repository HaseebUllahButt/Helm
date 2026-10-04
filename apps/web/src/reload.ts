export function reloadApp() {
  const target = new URL(location.href);
  target.searchParams.set('helm-refresh', '1');
  location.replace(target.href);
}

export function clearRefreshMarker() {
  const target = new URL(location.href);
  if (!target.searchParams.has('helm-refresh')) return;
  target.searchParams.delete('helm-refresh');
  history.replaceState(history.state, '', target.href);
}
