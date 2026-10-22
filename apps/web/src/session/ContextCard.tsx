import { Markdown } from '../Markdown';
import type { ContextUsage } from './contextUsage';

const SHADES = ['var(--primary-q)', 'var(--sky)', 'var(--emerald)', 'var(--amber)', 'var(--claude)', 'var(--opencode)', 'var(--red)'];

/**
 * How full the chat's memory is, as one bar: what is in it, what Claude
 * keeps back for summarising, and what is still free. The long lists
 * (skills, memory files, tools) fold away under it.
 */
export function ContextCard({ usage }: { usage: ContextUsage }) {
  const used = usage.parts.filter((p) => p.kind === 'used');
  const reserved = usage.parts.find((p) => p.kind === 'reserved');
  const free = usage.parts.find((p) => p.kind === 'free');
  const unloaded = usage.parts.filter((p) => p.kind === 'unloaded');
  const shade = (i: number) => SHADES[i % SHADES.length];
  return (
    <div className="ctxcard">
      <div className="ctx-head">
        <b>Chat memory</b>
        <span className="ctx-total">{usage.used} of {usage.size} · {usage.pct}%</span>
      </div>
      {usage.model && <div className="ctx-model">{usage.model}</div>}
      <div className="ctx-bar" role="img" aria-label={`Chat memory: ${usage.pct}% used`}>
        {used.map((p, i) => p.pct > 0 && <i key={p.name} style={{ width: `${p.pct}%`, background: shade(i) }} title={`${p.name}: ${p.tokens}`} />)}
        {reserved && reserved.pct > 0 && <i className="reserved" style={{ width: `${reserved.pct}%` }} title={`${reserved.name}: ${reserved.tokens}`} />}
      </div>
      <ul className="ctx-legend">
        {used.map((p, i) => (
          <li key={p.name}><i style={{ background: shade(i) }} /><span className="grow">{p.name}</span><span>{p.tokens}</span><span className="pct">{p.pct}%</span></li>
        ))}
        {reserved && <li className="dim"><i className="reserved" /><span className="grow">{reserved.name}</span><span>{reserved.tokens}</span><span className="pct">{reserved.pct}%</span></li>}
        {free && <li className="dim"><i className="free" /><span className="grow">{free.name}</span><span>{free.tokens}</span><span className="pct">{free.pct}%</span></li>}
        {unloaded.map((p) => (
          <li key={p.name} className="dim" title="Claude loads this item when it uses it."><i className="free" /><span className="grow">{p.name} · not loaded</span><span>{p.tokens}</span><span className="pct" /></li>
        ))}
      </ul>
      {usage.sections.map((s) => (
        <details key={s.title} className="ctx-more">
          <summary>{s.title}{s.rows > 0 && <span className="ctx-count">{s.rows}</span>}</summary>
          <Markdown text={s.text} className="prose" />
        </details>
      ))}
    </div>
  );
}
