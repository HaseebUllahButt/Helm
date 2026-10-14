import type { Client } from './client';
import type { DeviceAction, DeviceCatalog, DeviceFrame, DeviceReadiness, MobileDevice } from '../../../packages/protocol/devices';
export type { DeviceAction, DeviceCatalog, DeviceFrame, DeviceReadiness, MobileDevice };
export type DeviceRpc = Pick<Client, 'rpc'>;
export const deviceClient = (client: DeviceRpc, machine: string, sessionId?: string) => {
  const call = <T,>(method: string, params: object = {}, timeout = 30_000) => client.rpc<T>(machine, `device.${method}`, { ...params, ...(sessionId ? { sessionId } : {}) }, timeout);
  return {
    list: () => call<DeviceCatalog>('list'),
    readiness: () => call<DeviceReadiness>('readiness'),
    open: (deviceId: string) => call<{ device: MobileDevice; quickStart: string }>('open', { deviceId }, 200_000),
    close: () => call('close'),
    watch: (deviceId: string) => call<{ watchId: string; device: MobileDevice; intervalMs: number }>('watch', { deviceId }),
    unwatch: (watchId: string) => call('unwatch', { watchId }),
    frame: (watchId: string) => call<DeviceFrame>('frame', { watchId }),
    action: (deviceId: string, action: DeviceAction) => call('action', { deviceId, action }, 200_000),
    screenshot: (deviceId: string) => call<DeviceFrame>('screenshot', { deviceId }),
  };
};
/** Translate only supported keyboard input, leaving browser shortcuts alone. */
export function deviceKeyboardAction(event: Pick<KeyboardEvent, 'key' | 'altKey' | 'ctrlKey' | 'metaKey'>): DeviceAction | null {
  if (event.altKey || event.ctrlKey || event.metaKey) return null;
  const keys: Record<string, DeviceAction & { type: 'key' }> = {
    Enter: { type: 'key', key: 'enter' }, Backspace: { type: 'key', key: 'backspace' }, Escape: { type: 'key', key: 'back' }, Home: { type: 'key', key: 'home' },
  };
  return keys[event.key] || (event.key.length === 1 ? { type: 'type', text: event.key } : null);
}
export function devicePoint(clientX: number, clientY: number, rect: Pick<DOMRect, 'left' | 'top' | 'width' | 'height'>, frame: Pick<DeviceFrame, 'width' | 'height'>) {
  return { x: Math.max(0, Math.min(frame.width - 1, Math.round((clientX - rect.left) * frame.width / rect.width))), y: Math.max(0, Math.min(frame.height - 1, Math.round((clientY - rect.top) * frame.height / rect.height))) };
}
