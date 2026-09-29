import { useState } from 'react';
import { applyAppearance, loadAppearance, saveAppearance, type Appearance } from './appearance';

/** Four small choices about how helm looks on this device. */
export function AppearanceSettings() {
  const [a, setA] = useState<Appearance>(loadAppearance);
  const set = <K extends keyof Appearance>(k: K, v: Appearance[K]) => {
    const next = { ...a, [k]: v };
    setA(next);
    saveAppearance(next);
    applyAppearance(next);
  };
  const seg = <K extends keyof Appearance>(k: K, label: string, note: string, options: [Appearance[K], string][]) => (
    <div className="row appearance">
      <span className="grow">
        <span className="rt">{label}</span>
        <span className="rm">{note}</span>
        <span className="segmented">
          {options.map(([v, text]) => (
            <button key={String(v)} className={a[k] === v ? 'on' : ''} aria-pressed={a[k] === v} onClick={() => set(k, v)}>{text}</button>
          ))}
        </span>
      </span>
    </div>
  );
  return (
    <>
      {seg('theme', 'Theme', 'Light reads better outdoors', [['system', 'System'], ['dark', 'Dark'], ['light', 'Light']])}
      {seg('diff', 'Diff colours', 'Blue and orange if red and green look alike', [['green', 'Green / red'], ['blue', 'Blue / orange']])}
      {seg('width', 'Chat width', 'On a wide screen', [['comfortable', 'Comfortable'], ['wide', 'Wide']])}
      {seg('density', 'Lists', 'How much of each thread fits', [['comfortable', 'Comfortable'], ['compact', 'Compact']])}
    </>
  );
}
