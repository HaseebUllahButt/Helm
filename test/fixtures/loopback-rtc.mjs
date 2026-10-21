// Preload for native WebRTC tests: no public STUN or non-loopback ICE.
import { registerHooks } from 'node:module';
registerHooks({
  resolve(specifier, context, nextResolve) {
    const resolved = nextResolve(specifier, context);
    if (specifier !== 'node-datachannel/polyfill') return resolved;
    const source = `
      export * from ${JSON.stringify(resolved.url)};
      import { RTCPeerConnection as Native } from ${JSON.stringify(resolved.url)};
      export class RTCPeerConnection extends Native {
        constructor(config = {}) {
          // Two simulated machines in this process cannot share one mux
          // socket and then connect it to itself. Real-machine coverage
          // uses separate processes and keeps production multiplexing.
          super({ ...config, iceServers: [], bindAddress: '127.0.0.1', enableIceUdpMux: false });
        }
      }
    `;
    return { url: 'data:text/javascript,' + encodeURIComponent(source), shortCircuit: true };
  },
});
