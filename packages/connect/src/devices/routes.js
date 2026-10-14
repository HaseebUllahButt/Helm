import { DEVICE_METHODS } from '../../../protocol/devices.js';
const known = new Set(Object.values(DEVICE_METHODS));
const writes = new Set(['device.start', 'device.open', 'device.close', 'device.action', 'device.agent']);
/** One instance per daemon; construction loads no tool or child process. */
export function createDeviceRoutes({ service, getSession } = {}) {
  let loading, stopped = false;
  const load = async () => {
    if (service) return service;
    loading ||= import('./service.js').then(({ DeviceService }) => (service = new DeviceService()));
    return loading;
  };
  return {
    handles: (method) => known.has(method),
    async dispatch(method, params = {}, caller = 'local') {
      if (stopped) throw new Error('Device routes are stopped.');
      if (!known.has(method)) throw new Error('Unknown device method.');
      if (!params || typeof params !== 'object' || Array.isArray(params)) throw new Error('Invalid device parameters.');
      if (params.sessionId && getSession) {
        const session = getSession(params.sessionId);
        if (writes.has(method) && ['plan', 'readonly', 'read'].includes(session.mode)) throw new Error('A read-only session cannot control devices.');
      }
      const devices = await load();
      switch (method) {
        case 'device.readiness': return devices.readiness();
        case 'device.list': return devices.list(params);
        case 'device.start': return devices.start(params);
        case 'device.open': return devices.open(params);
        case 'device.close': return devices.close(params);
        case 'device.watch': return devices.watch(params, caller);
        case 'device.unwatch': return devices.unwatch(params, caller);
        case 'device.frame': return devices.frame(params, caller);
        case 'device.action': return devices.action(params);
        case 'device.screenshot': return devices.screenshot(params);
        case 'device.agent': return devices.agent(params);
      }
    },
    stop: async () => { stopped = true; if (loading) await loading; await service?.stop(); },
  };
}
