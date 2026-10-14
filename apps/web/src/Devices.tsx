import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent } from 'react';
import type { Environment } from './client';
import { BackIcon } from './Icon';
import { deviceClient, deviceKeyboardAction, devicePoint, type DeviceAction, type DeviceCatalog, type DeviceFrame, type DeviceRpc, type MobileDevice } from './deviceClient';

export { DeviceAccess } from './DeviceAccess';

export function DevicesView({ client, env, sessionId, onBack }: {
  client: DeviceRpc; env: Environment; sessionId?: string; onBack: () => void;
}) {
  const api = useMemo(() => deviceClient(client, env.id, sessionId), [client, env.id, sessionId]);
  const [catalog, setCatalog] = useState<DeviceCatalog>();
  const [device, setDevice] = useState<MobileDevice>();
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [live, setLive] = useState(true);
  const [refresh, setRefresh] = useState(0);
  const generation = useRef(0);
  useEffect(() => {
    let active = true; generation.current++;
    setBusy(false); setLoading(true); setError(''); setDevice(undefined); setCatalog(undefined);
    api.list().then((value) => {
      if (!active) return;
      setCatalog(value);
      const linked = sessionId && value.sessions.find((s) => s.sessionId === sessionId);
      if (linked) setDevice(value.devices.find((d) => d.id === linked.deviceId && d.state === 'running'));
    }).catch((e) => { if (active) setError(e.message); }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; generation.current++; };
  }, [api, sessionId, refresh]);
  // A device opened later by the agent appears without reopening the panel.
  useEffect(() => {
    if (!sessionId || loading) return;
    let active = true, pending = false;
    const timer = setInterval(() => {
      if (pending || document.hidden) return;
      pending = true;
      api.list().then((value) => {
        if (!active) return;
        setCatalog(value);
        const linked = value.sessions.find((s) => s.sessionId === sessionId);
        if (linked) setDevice((current) => current?.id === linked.deviceId ? current : value.devices.find((d) => d.id === linked.deviceId && d.state === 'running'));
      }).catch((e) => { if (active) setError(e.message); }).finally(() => { pending = false; });
    }, 5000);
    return () => { active = false; clearInterval(timer); };
  }, [api, sessionId, loading]);
  const open = async (row: MobileDevice) => {
    const current = generation.current; setBusy(true); setError('');
    try { const result = await api.open(row.id); if (generation.current === current) { setDevice(result.device); setLive(true); } }
    catch (e) { if (generation.current === current) setError((e as Error).message); }
    finally { if (generation.current === current) setBusy(false); }
  };
  return <>
    <div className="bar"><button className="iconbtn back" aria-label="Back" onClick={onBack}><BackIcon /></button><b>Devices</b><span className="spacer" /><button className="linkish" disabled={busy || loading} onClick={() => setRefresh((v) => v + 1)}>Refresh</button></div>
    <div className="scroll"><div className="pad column mobile-devices">
      <p className="note">{env.name}{sessionId ? ' · Watching alongside this thread' : ''}</p>
      {error && <p className="note" role="alert">{error}</p>}
      {loading && <p className="note">Checking installed device tools…</p>}
      {catalog && <>
        {catalog.errors.map((message) => <p className="note" role="alert" key={message}>{message}</p>)}
        <div className="device-picker">
          {catalog.devices.map((row) => <button className="row" key={row.id} disabled={busy || row.state === 'unauthorized' || row.state === 'offline'} aria-pressed={device?.id === row.id} onClick={() => void open(row)}>
            <span className="grow"><span className="rt">{row.name}</span><span className="rm">{row.platform === 'ios' ? 'iOS simulator' : row.kind === 'physical' ? 'Android device' : 'Android emulator'} · {row.state}{row.version ? ` · ${row.version}` : ''}</span></span>
            <span>{row.state === 'running' ? 'View' : row.state === 'stopped' ? 'Start & view' : 'Reconnect'}</span>
          </button>)}
        </div>
        {busy && <p className="note" role="status">Starting device… This can take a few minutes.</p>}
        {!catalog.devices.length && <p className="note">No devices found. Check the setup instructions below, then refresh.</p>}
        {device && <>
          <div className="device-view-bar"><b>{device.name}</b><button className="linkish" onClick={() => setLive((value) => !value)}>{live ? 'Pause viewing' : 'Resume viewing'}</button><button className="linkish" onClick={() => { setDevice(undefined); if (sessionId) void api.close().catch((e) => setError(e.message)); }}>Close viewer</button></div>
          <DeviceViewer key={device.id} api={api} device={device} live={live} />
        </>}
        <details className="device-setup" open={!catalog.devices.length}><summary>Device setup on {env.name}</summary>
          {(['android', 'ios'] as const).map((platform) => <div key={platform}><b>{platform === 'ios' ? 'iOS' : 'Android'}</b><p className="note">{catalog.readiness[platform].reason}</p><ul>{catalog.readiness[platform].setup.map((line) => <li key={line}>{line}</li>)}</ul></div>)}
          <p className="note">Helm reuses installed tools. SDKs, runtimes and system images are installed explicitly on the host. Remote frames use your existing authenticated Helm connection. Device builds, app installation and Metro forwarding stay on the device host.</p>
        </details>
      </>}
    </div></div>
  </>;
}

type Api = ReturnType<typeof deviceClient>;
export function DeviceViewer({ api, device, live }: { api: Api; device: MobileDevice; live: boolean }) {
  const [frame, setFrame] = useState<DeviceFrame>();
  const [src, setSrc] = useState('');
  const [error, setError] = useState('');
  const [status, setStatus] = useState('Connecting…');
  const [visible, setVisible] = useState(!document.hidden);
  const [text, setText] = useState('');
  const [app, setApp] = useState('');
  const [pending, setPending] = useState(0);
  const [retry, setRetry] = useState(0);
  const mounted = useRef(true), queue = useRef(Promise.resolve()), depth = useRef(0);
  const gesture = useRef<{ x: number; y: number; at: number; pointer: number }>();
  const imageRef = useRef<HTMLImageElement>(null);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => {
    const changed = () => setVisible(!document.hidden);
    document.addEventListener('visibilitychange', changed);
    return () => document.removeEventListener('visibilitychange', changed);
  }, []);
  useEffect(() => {
    if (!live || !visible) { setStatus('Viewing paused'); return; }
    let active = true, watchId = '', timer: ReturnType<typeof setTimeout>;
    setStatus('Connecting…'); setError('');
    const receive = async (interval: number) => {
      try {
        const next = await api.frame(watchId);
        if (!active) return;
        const url = `data:${next.mimeType};base64,${next.data}`;
        // Decode before asking for another frame; one RPC + one image at most.
        const decoded = new Image(); decoded.src = url; await decoded.decode();
        if (!active) return;
        setFrame(next); setSrc(url); setStatus('Live');
        timer = setTimeout(() => void receive(interval), interval);
      } catch (e) { if (active) { setError((e as Error).message); setStatus('Viewing stopped'); if (watchId) void api.unwatch(watchId).catch(() => {}); } }
    };
    void api.watch(device.id).then((result) => {
      watchId = result.watchId;
      if (!active) { void api.unwatch(watchId).catch(() => {}); return; }
      void receive(result.intervalMs);
    }).catch((e) => { if (active) { setError(e.message); setStatus('Viewing stopped'); } });
    return () => { active = false; clearTimeout(timer); if (watchId) void api.unwatch(watchId).catch(() => {}); };
  }, [api, device.id, live, visible, retry]);
  const act = useCallback((action: DeviceAction) => {
    if (depth.current >= 16) { setError('Input is busy. Wait for the current actions to finish.'); return; }
    depth.current++; setPending(depth.current); setError('');
    queue.current = queue.current.then(async () => { if (mounted.current) await api.action(device.id, action); })
      .catch((e) => { if (mounted.current) setError(e.message); })
      .finally(() => { depth.current--; if (mounted.current) setPending(depth.current); });
  }, [api, device.id]);
  const point = (event: PointerEvent) => imageRef.current && frame ? devicePoint(event.clientX, event.clientY, imageRef.current.getBoundingClientRect(), frame) : undefined;
  const screenshot = async () => {
    try {
      const shot = await api.screenshot(device.id);
      const anchor = document.createElement('a'); anchor.href = `data:${shot.mimeType};base64,${shot.data}`; anchor.download = `${device.platform}-screenshot.png`; anchor.click();
    } catch (e) { setError((e as Error).message); }
  };
  return <div className="device-viewer">
    <div className="device-status" role="status">{status}{pending ? ` · ${pending} input pending` : ''}</div>
    {error && <p className="note" role="alert">{error} <button className="linkish" onClick={() => setRetry((v) => v + 1)}>Retry viewing</button></p>}
    {!device.control && <p className="note">Viewing is available. Install agent-device on this Mac to enable taps, swipes and text.</p>}
    <div className="device-screen-wrap"><div className="device-screen" role="application" aria-label={`${device.name} interactive screen`} tabIndex={device.control ? 0 : -1}
      onKeyDown={(event) => { const action = deviceKeyboardAction(event.nativeEvent); if (device.control && frame && action && !(device.platform === 'ios' && action.type === 'key' && action.key === 'back')) { event.preventDefault(); act(action); } }}
      onPointerDown={(event) => { const start = point(event); if (!device.control || !start || event.button !== 0) return; event.preventDefault(); event.currentTarget.focus(); event.currentTarget.setPointerCapture(event.pointerId); gesture.current = { ...start, pointer: event.pointerId, at: Date.now() }; }}
      onPointerUp={(event) => { const end = point(event), start = gesture.current; gesture.current = undefined; if (!start || !end || start.pointer !== event.pointerId) return; if (Math.hypot(start.x - end.x, start.y - end.y) < 8) act({ type: 'tap', x: end.x, y: end.y }); else act({ type: 'swipe', x: start.x, y: start.y, x2: end.x, y2: end.y, duration: Math.max(50, Math.min(5000, Date.now() - start.at)) }); }}
      onPointerCancel={() => { gesture.current = undefined; }}>
      {src ? <img ref={imageRef} src={src} width={frame?.width} height={frame?.height} alt={`${device.name} current screen`} draggable={false} /> : <p className="note">Waiting for screen…</p>}
    </div></div>
    <div className="device-controls">
      <button className="linkish" disabled={!device.control} onClick={() => act({ type: 'key', key: 'home' })}>Home</button>
      {device.platform === 'android' && <button className="linkish" disabled={!device.control} onClick={() => act({ type: 'key', key: 'back' })}>Back</button>}
      <button className="linkish" disabled={!device.control} onClick={() => act({ type: 'key', key: 'enter' })}>Enter</button>
      <button className="linkish" disabled={!device.control} onClick={() => act({ type: 'key', key: 'backspace' })}>Delete</button>
      <button className="linkish" onClick={() => void screenshot()}>Save screenshot</button>
    </div>
    <form className="device-input" onSubmit={(event) => { event.preventDefault(); if (text) { act({ type: 'type', text }); setText(''); } }}><input aria-label="Text to type on device" placeholder="Type into focused device field" maxLength={4096} value={text} disabled={!device.control} onChange={(e) => setText(e.target.value)} /><button className="linkish" disabled={!device.control || !text || pending >= 16}>Type</button></form>
    <form className="device-input" onSubmit={(event) => { event.preventDefault(); if (app) act({ type: 'open', ...(/^[a-z][a-z0-9+.-]*:/i.test(app) ? { url: app } : { app }) }); }}><input aria-label="App ID or deep link" placeholder="App package / bundle ID or deep link" maxLength={4096} value={app} onChange={(e) => setApp(e.target.value)} /><button className="linkish" disabled={!app || pending >= 16}>Open app</button></form>
    <p className="note">Tap or drag the screen to interact. Focus the screen for keyboard input, or use Type for longer text. Viewing pauses when this page is hidden. Closing the viewer leaves the device running.</p>
  </div>;
}
