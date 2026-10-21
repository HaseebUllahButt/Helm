import { loadSettings } from './settings.js';

// A known UDP range lets a public machine accept direct connections through
// its host and cloud firewalls. Multiplexing shares sockets between peers;
// the range is not a limit on the number of chats or connections.
export const DIRECT_PORTS = { begin: 44301, end: 44332 };

export function nativeDirectConfig(settings = loadSettings()) {
  const ports = settings.directPorts ?? DIRECT_PORTS;
  if (!Number.isInteger(ports.begin) || !Number.isInteger(ports.end)
    || ports.begin < 1024 || ports.end > 65535 || ports.begin >= ports.end) {
    // libjuice needs a non-empty half-open range; equal bounds can hang
    // native candidate gathering instead of rejecting the configuration.
    throw new Error('directPorts must contain begin < end between 1024 and 65535');
  }
  return {
    iceServers: [
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'stun:stun.cloudflare.com:3478' },
    ],
    enableIceUdpMux: true,
    portRangeBegin: ports.begin,
    portRangeEnd: ports.end,
  };
}
