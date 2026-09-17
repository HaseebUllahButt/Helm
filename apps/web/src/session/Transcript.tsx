import { useEffect, useRef, useState } from 'react';
import { Markdown } from '../Markdown';
import type { Change, Item, Turn } from './types';
import { money, seconds } from '../format';

/**
 * The conversation, live.
 *
 * Text arrives a few words at a time and is shown as it lands, eased so a
 * burst reads as typing rather than popping. Tool calls are one line each
 * while they run and fold their output away when they finish; commands and
 * file changes get a little more room because what they did is the point.
 */

const TOOL_GLYPH: Record<string, string> = {
  Read: '◎', Write: '✎', Edit: '✎', MultiEdit: '✎', NotebookEdit: '✎', Bash: '❯', Grep: '⌕', Glob: '⌕',
  WebFetch: '⇣', WebSearch: '⌕', Task: '⚙', Agent: '⚙', AskUserQuestion: '?', ExitPlanMode: '☰',
  ToolSearch: '⌕', mcpToolCall: '⚙', webSearch: '⌕',
};
export const toolGlyph = (name = '') =>
  TOOL_GLYPH[name] ?? (/read|cat|view/i.test(name) ? '◎'
    : /search|grep|glob|list|find/i.test(name) ? '⌕'
    : /write|edit|patch|create/i.test(name) ? '✎'
    : /bash|shell|exec|run|command/i.test(name) ? '❯' : '⚙');

const shortPath = (p = '') => {
  const parts = p.replace(/\/$/, '').split('/');
  return parts.length > 3 ? '…/' + parts.slice(-2).join('/') : p;
};


/**
 * Show text as it arrives, but never all at once: the visible length chases
 * the real length, faster when it falls behind.
 *
 * The cadence is deliberate. Every step re-renders this message, and a
 * re-render re-parses the whole thing through marked, DOMPurify and the
 * syntax highlighter - 1.5ms for a 3.5KB reply on a laptop, several times
 * that on a phone. Stepping once a frame spent all of it on an effect no
 * one can perceive: tokens arrive from the agent about fifteen times a
 * second, so revealing them twenty times a second is already smoother than
 * the source. Sixty was three times the cost for no visible gain.
 */
const STEP_MS = 45;

function useTyped(text: string, live: boolean) {
  const [shown, setShown] = useState(live ? 0 : text.length);
  const shownRef = useRef(shown);
  useEffect(() => {
    if (!live) { shownRef.current = text.length; setShown(text.length); return; }
    if (matchMedia('(prefers-reduced-motion: reduce)').matches) { shownRef.current = text.length; setShown(text.length); return; }
    if (shownRef.current >= text.length) return;
    const timer = setInterval(() => {
      const behind = text.length - shownRef.current;
      if (behind <= 0) { clearInterval(timer); return; }
      // Catch up within a few steps however far behind we are, so a burst
      // of tokens never leaves the reveal trailing the agent.
      shownRef.current += Math.max(3, Math.ceil(behind / 3));
      setShown(Math.min(shownRef.current, text.length));
    }, STEP_MS);
    return () => clearInterval(timer);
  }, [text, live]);
  return live ? text.slice(0, Math.min(shown, text.length)) : text;
}

// ------------------------------------------------------------------- items

function TextItem({ item }: { item: Item }) {
  const live = item.status === 'streaming';
  const text = useTyped(item.text, live);
  if (!text && !live) return null;
  return <Markdown text={text} className={`prose${live ? ' live' : ''}`} />;
}

function ThinkingItem({ item }: { item: Item }) {
  const live = item.status === 'streaming';
  const took = item.doneAt && item.startedAt ? item.doneAt - item.startedAt : 0;
  const label = live ? 'Thinking' : took > 1500 ? `Thought for ${seconds(took)}` : 'Thought';
  if (!live && !item.text) return <div className="act quiet"><span className="aicon">◌</span><span className="alabel">{label}</span></div>;
  return (
    <details className="actgroup think">
      <summary>
        <span className="aicon">◌</span>
        <span className={`alabel${live ? ' shine' : ''}`}>{label}</span>
        {item.text && <span className="achev">›</span>}
      </summary>
      {item.text && <div className="think-body">{item.text}</div>}
    </details>
  );
}

/** The one line that describes what a tool is doing, from whatever input we have. */
function toolSummary(item: Item): string {
  const input = item.input ?? tryParse(item.inputJson);
  if (input && typeof input === 'object') {
    const v = input.command ?? input.file_path ?? input.path ?? input.notebook_path ?? input.pattern ?? input.query ?? input.url
      ?? input.questions?.[0]?.question ?? input.description ?? input.prompt ?? input.plan;
    if (typeof v === 'string') return v.length > 140 ? v.slice(0, 140) + '…' : v;
  }
  // Still streaming: show the first string value once its key has landed, never raw JSON.
  const m = item.inputJson?.match(/"(?:command|file_path|path|pattern|query|url|question|description)"\s*:\s*"((?:[^"\\]|\\.)*)/);
  return m ? m[1].slice(0, 140) : '';
}
const tryParse = (s?: string) => { if (!s) return undefined; try { return JSON.parse(s); } catch { return undefined; } };

function ToolItem({ item }: { item: Item }) {
  const live = item.status === 'streaming';
  const summary = toolSummary(item);
  const out = item.output ?? '';
  const body = out || item.error;
  const head = (
    <>
      <span className={`aicon${item.status === 'error' ? ' bad' : ''}`}>{toolGlyph(item.name)}</span>
      <span className={`alabel${live ? ' shine' : ''}`}>
        <b>{item.name}</b>{summary && <> {summary}</>}
      </span>
      {live && item.elapsed != null && item.elapsed > 2 && <span className="ameta">{Math.round(item.elapsed)}s</span>}
      {item.status === 'error' && <span className="ameta bad">failed</span>}
      {item.status === 'declined' && <span className="ameta">declined</span>}
    </>
  );
  if (!body) return <div className="act">{head}</div>;
  return (
    <details className="actgroup">
      <summary>{head}<span className="achev">›</span></summary>
      <pre className="aout">{body.length > 4000 ? body.slice(0, 4000) + '\n…' : body}</pre>
    </details>
  );
}

function CommandItem({ item }: { item: Item }) {
  const live = item.status === 'streaming';
  const out = (item.output ?? item.text ?? '').replace(/\s+$/, '');
  const lines = out ? out.split('\n') : [];
  const [open, setOpen] = useState(false);
  const tail = open ? lines : lines.slice(-6);
  return (
    <div className={`cmd${item.status === 'error' ? ' bad' : ''}`}>
      <div className="cmd-head">
        <span className={`aicon${item.status === 'error' ? ' bad' : ''}`}>❯</span>
        <code className={`cmd-line${live ? ' shine' : ''}`}>{item.command}</code>
        {item.status === 'declined' && <span className="ameta">declined</span>}
        {item.exitCode != null && item.exitCode !== 0 && <span className="ameta bad">exit {item.exitCode}</span>}
        {live && item.elapsed != null && item.elapsed > 2 && <span className="ameta">{Math.round(item.elapsed)}s</span>}
      </div>
      {lines.length > 0 && (
        <pre className="cmd-out" onClick={() => lines.length > 6 && setOpen((v) => !v)}>
          {lines.length > 6 && !open && <span className="more">… {lines.length - 6} more lines</span>}
          {tail.join('\n')}
        </pre>
      )}
    </div>
  );
}

const diffCounts = (diff = '') => {
  let add = 0, del = 0;
  for (const l of diff.split('\n')) {
    if (l.startsWith('+') && !l.startsWith('+++')) add++;
    else if (l.startsWith('-') && !l.startsWith('---')) del++;
  }
  return { add, del };
};

export function Diff({ text }: { text: string }) {
  return (
    <pre className="diff">
      {text.split('\n').map((l, i) => (
        <span key={i} className={l.startsWith('+') ? 'add' : l.startsWith('-') ? 'del' : l.startsWith('@@') ? 'hunk' : ''}>{l}{'\n'}</span>
      ))}
    </pre>
  );
}

export function ChangeList({ changes, open = false }: { changes: Change[]; open?: boolean }) {
  return (
    <>
      {changes.map((c, i) => {
        // Codex sends an added file as its content, not a unified diff.
        const unified = /^(---|\+\+\+|@@|diff )/m.test(c.diff);
        const shown = unified ? c.diff : c.diff.split('\n').map((l) => (c.kind === 'delete' ? '-' : '+') + l).join('\n');
        const { add, del } = diffCounts(shown);
        return (
          <details key={i} className="edit" open={open}>
            <summary>
              <span className="aicon">✎</span>
              <span className="alabel"><b>{c.kind === 'add' ? 'Create' : c.kind === 'delete' ? 'Delete' : 'Edit'}</b> {shortPath(c.path)}</span>
              <span className="ameta"><i className="add">+{add}</i> <i className="del">−{del}</i></span>
              <span className="achev">›</span>
            </summary>
            <Diff text={shown} />
          </details>
        );
      })}
    </>
  );
}

function EditItem({ item }: { item: Item }) {
  const changes = item.changes ?? [];
  if (!changes.length) return <div className="act"><span className="aicon">✎</span><span className="alabel"><b>Edit</b></span></div>;
  return <div className={`edits${item.status === 'declined' ? ' declined' : item.status === 'error' ? ' bad' : ''}`}><ChangeList changes={changes} /></div>;
}

/** 48210 -> 48.2k. A subagent's token count is a sense of scale, not a bill. */
const tokens = (n?: number) => (
  n == null || n <= 0 ? ''
    : n < 1000 ? String(n)
    : n < 100_000 ? `${(n / 1000).toFixed(1).replace(/\.0$/, '')}k`
    : `${Math.round(n / 1000)}k`
);

/**
 * A spawned agent. The card says who it is and what it was asked; while it
 * runs its own tool calls and text stream inside, nested by the drivers'
 * parentId tagging. Folds away when it finishes like any other tool.
 *
 * What it cost outlives the run. The driver had been collecting a token count
 * for every subagent since subagents landed and nothing ever displayed one,
 * because the frame that said the agent had finished replaced the frame that
 * held the numbers. A folded card now carries them.
 */
function SubagentItem({ item, byParent }: { item: Item; byParent: Map<string, Item[]> }) {
  const live = item.status === 'streaming';
  const input = item.input ?? tryParse(item.inputJson);
  const who = input?.subagent_type ?? item.name ?? 'subagent';
  const task = input?.description ?? input?.prompt ?? item.agent?.description ?? '';
  const kids = byParent.get(item.id) ?? [];
  const out = item.output ?? item.agent?.summary ?? '';
  const used = tokens(item.agent?.tokens);
  const calls = item.agent?.toolUses;
  // While it runs, what it is doing now beats what it was asked: the engine
  // rewrites `description` as the child works, and nothing showed it.
  const doing = live && item.agent?.description ? item.agent.description : task;
  const head = (
    <>
      <span className={`aicon${item.status === 'error' ? ' bad' : ''}`}>⧉</span>
      <span className={`alabel${live ? ' shine' : ''}`}>
        <b>{who}</b>{doing && <> {typeof doing === 'string' && doing.length > 140 ? doing.slice(0, 140) + '…' : String(doing)}</>}
      </span>
      {live && item.agent?.lastTool && <span className="ameta">{item.agent.lastTool}</span>}
      {!live && !!calls && <span className="ameta">{calls} {calls === 1 ? 'tool' : 'tools'}</span>}
      {used && <span className="ameta">{used}</span>}
      {live && item.elapsed != null && item.elapsed > 2 && <span className="ameta">{Math.round(item.elapsed)}s</span>}
      {item.status === 'error' && <span className="ameta bad">failed</span>}
      {item.status === 'declined' && <span className="ameta">stopped</span>}
    </>
  );
  if (!kids.length && !out) return <div className="act">{head}</div>;
  return (
    <details className="actgroup subagent" open={live || undefined}>
      <summary>{head}<span className="achev">›</span></summary>
      <div className="sub-body">
        {kids.map((k) => <ItemView key={k.id} item={k} byParent={byParent} />)}
        {out && <pre className="aout">{out.length > 4000 ? out.slice(0, 4000) + '\n…' : out}</pre>}
      </div>
    </details>
  );
}

function ItemView({ item, byParent }: { item: Item; byParent: Map<string, Item[]> }) {
  switch (item.kind) {
    case 'text': return <TextItem item={item} />;
    case 'thinking': return <ThinkingItem item={item} />;
    case 'tool': return <ToolItem item={item} />;
    case 'command': return <CommandItem item={item} />;
    case 'edit': return <EditItem item={item} />;
    case 'subagent': return <SubagentItem item={item} byParent={byParent} />;
    case 'error': return <div className="act bad"><span className="aicon bad">!</span><span className="alabel wrap">{item.text}</span></div>;
    default: return null;
  }
}

// ------------------------------------------------------------------- turns

/**
 * What helm put in front of what the owner typed, split back off it.
 *
 * The brain gets a line of network state prepended to every message, because
 * it is asked about machines rather than about the folder it is sitting in.
 * That line was really sent and really in the model's context, so hiding it
 * would be a lie - but it is helm talking, not the owner, and in their own
 * bubble in their own words it reads as though they typed it. It gets its
 * own quiet line instead.
 */
const HELM_NOTE = /^(\[helm [^\]\n]*\])\n\n([\s\S]*)$/;
function splitNote(text?: string): { note?: string; text?: string } {
  const m = text ? HELM_NOTE.exec(text) : null;
  return m ? { note: m[1], text: m[2] } : { text };
}

function TurnView({ turn, working, blocked }: { turn: Turn; working: boolean; blocked: boolean }) {
  const said = splitNote(turn.text);
  const d = turn.done;
  // Subagent children hang off their spawn card; a missing parent renders flat.
  const ids = new Set(turn.items.map((i) => i.id));
  const byParent = new Map<string, Item[]>();
  const roots = turn.items.filter((it) => {
    if (!it.parentId || !ids.has(it.parentId)) return true;
    const kids = byParent.get(it.parentId) ?? [];
    kids.push(it);
    byParent.set(it.parentId, kids);
    return false;
  });
  return (
    <>
      {(turn.text || turn.attachments?.length) && (
        <div className="turn user"><div className="bubble">
          {said.note && <span className="turn-note">{said.note}</span>}
          {said.text}
          {turn.attachments?.map((a, i) => (a.data
            // A blob the log has swept past still has its name, and saying
            // so beats a browser's broken-image glyph.
            ? <img key={i} className="turn-image" src={`data:${a.mime};base64,${a.data}`} alt={a.filename} title={a.filename} loading="lazy" />
            : <span key={i} className="turn-image-gone" title={a.filename}>🖼 {a.filename || 'image'} — no longer stored</span>
          ))}
        </div></div>
      )}
      <div className="turn assistant">
        {roots.map((it) => <ItemView key={it.id} item={it} byParent={byParent} />)}
        {!d && working && !turn.items.some((it) => it.status === 'streaming' && it.kind === 'text') && (
          blocked
            ? <div className="working quiet">Waiting for you</div>
            : <div className="working"><span className="shine">Working…</span></div>
        )}
        {d && (d.status === 'interrupted' ? <div className="turn-meta">stopped</div>
          : d.status === 'error' ? <div className="turn-meta bad">{d.error || 'the turn failed'}</div>
          : (d.durationMs || d.costUsd) ? <div className="turn-meta">{[seconds(d.durationMs), money(d.costUsd)].filter(Boolean).join(' · ')}</div> : null)}
      </div>
    </>
  );
}

export function Transcript({ turns, status, loaded, empty, earlier, loadingEarlier, onEarlier }: {
  turns: Turn[]; status: string; loaded: boolean; empty?: string;
  /** The machine holds more of this conversation than is on screen. */
  earlier?: boolean; loadingEarlier?: boolean; onEarlier?: () => void;
}) {
  const box = useRef<HTMLDivElement>(null);
  const stuck = useRef(true);
  const [unread, setUnread] = useState(false);
  const last = turns[turns.length - 1];
  const working = status === 'working' || status === 'blocked';

  const onScroll = () => {
    const el = box.current;
    if (!el) return;
    stuck.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    if (stuck.current) setUnread(false);
  };
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    if (stuck.current) el.scrollTop = el.scrollHeight;
    else setUnread(true);
  });

  const jump = () => {
    const el = box.current;
    if (el) { el.scrollTop = el.scrollHeight; stuck.current = true; setUnread(false); }
  };

  return (
    <div className="chat-wrap">
      <div className="chat" ref={box} onScroll={onScroll}>
        <div className="timeline">
          {/* A chat opens on its last screenful, because that is what you came
              for; the rest of it is a tap away rather than a wait. */}
          {loaded && earlier && (
            <button className="earlier" onClick={onEarlier} disabled={loadingEarlier}>
              {loadingEarlier ? 'reading…' : 'Earlier in this conversation'}
            </button>
          )}
          {!loaded && <p className="placeholder">Loading the conversation…</p>}
          {loaded && turns.length === 0 && <p className="placeholder">{empty ?? 'Send a message to start the conversation.'}</p>}
          {turns.map((t) => <TurnView key={t.id} turn={t} working={working && t === last} blocked={status === 'blocked'} />)}
        </div>
      </div>
      {unread && <button className="jump" onClick={jump}>↓ new</button>}
    </div>
  );
}
