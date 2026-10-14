export const DEVICE_METHODS: Readonly<Record<'readiness' | 'list' | 'start' | 'open' | 'close' | 'watch' | 'unwatch' | 'frame' | 'action' | 'screenshot' | 'agent', string>>;
export const DEVICE_LIMITS: Readonly<{ frameBytes: number; commandBytes: number; watchers: number; streams: number; sessions: number; leaseMs: number; frameIntervalMs: number }>;
export interface MobileDevice {
  id: string; target: string; name: string; platform: 'android' | 'ios';
  kind: 'physical' | 'emulator' | 'simulator'; state: 'running' | 'stopped' | 'unauthorized' | 'offline';
  version?: string; avd?: string; control: boolean;
}
export interface DeviceReadiness {
  platform: string;
  tools: { adb: string | null; emulator: string | null; xcrun: string | null; agent: string | null; hub: string | null };
  android: { available: boolean; reason: string; setup: string[] };
  ios: { available: boolean; reason: string; setup: string[] };
}
export interface DeviceCatalog { readiness: DeviceReadiness; devices: MobileDevice[]; errors: string[]; sessions: { sessionId: string; deviceId: string }[] }
export interface DeviceFrame { data: string; mimeType: 'image/png'; width: number; height: number; at: number }
export type DeviceAction =
  | { type: 'tap'; x: number; y: number }
  | { type: 'swipe'; x: number; y: number; x2: number; y2: number; duration?: number }
  | { type: 'type'; text: string }
  | { type: 'key'; key: 'home' | 'back' | 'enter' | 'backspace' | 'menu' | 'power' | 'volume-up' | 'volume-down' }
  | { type: 'open'; app?: string; url?: string };
