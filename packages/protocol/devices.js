/** Device operations travel on Helm's authenticated RPC, including remote frames. */
export const DEVICE_METHODS = Object.freeze({
  readiness: 'device.readiness', list: 'device.list', start: 'device.start',
  open: 'device.open', close: 'device.close', watch: 'device.watch',
  unwatch: 'device.unwatch', frame: 'device.frame', action: 'device.action',
  screenshot: 'device.screenshot', agent: 'device.agent',
});
export const DEVICE_LIMITS = Object.freeze({
  frameBytes: 4 * 1024 * 1024, commandBytes: 8 * 1024 * 1024,
  watchers: 32, streams: 8, sessions: 64, leaseMs: 30_000, frameIntervalMs: 500,
});
