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
  // One line each: the name, and its choices beside it.
  const seg = <K extends keyof Appearance>(k: K, label: string, options: [Appearance[K], string][], className = '') => (
    <div className={`row appearance${className ? ` ${className}` : ''}`}>
      <span className="grow"><span className="rt">{label}</span></span>
      <span className="segmented" role="group" aria-label={label}>
        {options.map(([v, text]) => (
          <button key={String(v)} className={a[k] === v ? 'on' : ''} aria-pressed={a[k] === v} onClick={() => set(k, v)}>{text}</button>
        ))}
      </span>
    </div>
  );
  return (
    <>
      {seg('theme', 'Theme', [['system', 'Auto'], ['dark', 'Dark'], ['light', 'Light']])}
      {seg('diff', 'Diff colours', [['green', 'Green/red'], ['blue', 'Blue/orange']])}
      {seg('width', 'Chat width', [['comfortable', 'Normal'], ['wide', 'Wide']], 'wide-only')}
      {seg('density', 'Lists', [['comfortable', 'Roomy'], ['compact', 'Compact']])}
    </>
  );
}
