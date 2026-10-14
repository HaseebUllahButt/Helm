/** Place in a thread toolbar; parent navigation retains the thread ID. */
export function DeviceAccess({ onOpenDevices }: { onOpenDevices: () => void }) {
  return <button className="linkish" onClick={onOpenDevices} title="Test an Android device or iOS simulator while this agent runs">Devices</button>;
}
