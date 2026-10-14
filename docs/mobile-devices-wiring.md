# Mobile device integration hooks

The parent change owns shared top-level files. This branch provides the
following hooks; merge and wire them with the other features before release.

* In Daemon, import `createDeviceRoutes` from `./devices/routes.js`.
  Construct `this.devices = createDeviceRoutes({ getSession: id => this.sessions.get(id) })`
  once per daemon (the callback is called only after sessions exists).
  Before the dispatch switch, route supported methods:
  `if (this.devices.handles(method)) return this.devices.dispatch(method, p, caller)`.
  During stop, `await this.devices.stop()` cancels device subprocesses and clears
  viewer leases before the daemon closes its links.
* Add `helm device` to CLI help and a case loading `runDeviceCommand` from
  `../src/device-cli.js` and calling it with
  `rest, { rpc: brainRpc, self: () => requireNetwork().self, machineId }`.
  Keep the existing plural `helm devices` behavior.
* Append `deviceNote()` from `./devices/instructions.js` to **both** helmBrief
  return paths. It explains CLI commands without starting or probing devices
  for every agent turn.
* Add `@import './devices.css';` to apps/web/src/styles.css. The component
  intentionally does not import CSS, keeping existing esbuild App fixtures usable.
* Lazy-load `DevicesView` from `./Devices` in App. Import the small thread
  button `DeviceAccess` from `./DeviceAccess` so it does not eagerly load the
  viewer. Daemon routes lazily import DeviceService on the first device RPC.
  `DevicesView({client, env, sessionId?, onBack})` is the machine screen.
  Add a Devices machine navigation entry and a palette entry. Session screens
  can place `<DeviceAccess onOpenDevices={() => openDevices(env, session.id)} />`
  in the toolbar. Parent `openDevices` should retain that session ID and return
  route; rendering DevicesView with it follows agent-opened devices. Return
  to the running thread with onBack. No thread restart or detach is needed.

RPC constants and shared types are in packages/protocol/devices.js/.d.ts,
exported as @helm/protocol/devices. The daemon route uses string methods and
does not require editing the shared M/E objects. deviceClient.ts wraps
Client.rpc for the UI. Its calls carry sessionId whenever attached to a
thread. Viewer leases are caller-bound; always forward dispatch's caller.
