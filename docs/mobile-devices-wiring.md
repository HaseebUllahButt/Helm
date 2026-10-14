# Mobile device integration hooks

The integration uses the following hooks. Keep these boundaries when extending
device support so unused device tools remain unloaded.

* Daemon imports `createDeviceRoutes` from `./devices/routes.js`.
  It constructs `this.devices = createDeviceRoutes({ getSession: id => this.sessions.get(id) })`
  once per daemon (the callback is called only after sessions exists).
  Before the dispatch switch, route supported methods:
  `if (this.devices.handles(method)) return this.devices.dispatch(method, p, caller)`.
  During stop, `await this.devices.stop()` cancels device subprocesses and clears
  viewer leases before the daemon closes its links.
* The `helm device` CLI case loads `runDeviceCommand` from
  `../src/device-cli.js` and calls it with
  `rest, { rpc: brainRpc, self: () => requireNetwork().self, machineId }`.
  Keep the existing plural `helm devices` behavior.
* Both helmBrief return paths append `deviceNote()` from
  `./devices/instructions.js`. It explains CLI commands without starting or probing devices
  for every agent turn.
* apps/web/src/styles.css includes `@import './devices.css';` The component
  intentionally does not import CSS, keeping existing esbuild App fixtures usable.
* App lazy-loads `DevicesView` from `./Devices` and imports the small thread
  button `DeviceAccess` from `./DeviceAccess` so it does not eagerly load the
  viewer. Daemon routes lazily import DeviceService on the first device RPC.
  `DevicesView({client, env, sessionId?, onBack})` is the machine screen.
  Machine navigation and the palette expose Mobile testing. Session screens use
  `<DeviceAccess onOpenDevices={() => openDevices(env, session.id)} />`
  in the toolbar. `openDevices` retains that session ID and return
  route; rendering DevicesView with it follows agent-opened devices. Return
  to the running thread with onBack. No thread restart or detach is needed.

RPC constants and shared types are in packages/protocol/devices.js/.d.ts,
exported as @helm/protocol/devices. The daemon route uses string methods and
does not require editing the shared M/E objects. deviceClient.ts wraps
Client.rpc for the UI. Its calls carry sessionId whenever attached to a
thread. Viewer leases are caller-bound; always forward dispatch's caller.
