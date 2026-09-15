import { useEffect, useRef, useState } from 'react';
import { Markdown } from '../Markdown';
import type { Change, Item, Turn } from './types';

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

const seconds = (ms?: number) => (ms == null ? '' : ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)}s`);
const money = (usd?: number) => (usd == null ? '' : usd < 0.01 ? '<$0.01' : `$${usd.toFixed(2)}`);

/**
 * Show text as it arrives, but never all at once: the visible length chases
 * the real length a few characters per frame, faster when it falls behind.
 */
function useTyped(text: string, live: boolean) {
  const [shown, setShown] = useState(live ? 0 : text.length);
  const shownRef = useRef(shown);
  useEffect(() => {
    if (!live) { shownRef.current = text.length; setShown(text.length); return; }
    if (matchMedia('(prefers-reduced-motion: reduce)').matches) { shownRef.current = text.length; setShown(text.length); return; }
    let raf = 0;
    const step = () => {
      const behind = text.length - shownRef.current;
      if (behind <= 0) return;
      shownRef.current += Math.max(2, Math.ceil(behind / 6));
      setShown(Math.min(shownRef.current, text.length));
      raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
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

function ItemView({ item }: { item: Item }) {
  switch (item.kind) {
    case 'text': return <TextItem item={item} />;
    case 'thinking': return <ThinkingItem item={item} />;
    case 'tool': return <ToolItem item={item} />;
    case 'command': return <CommandItem item={item} />;
    case 'edit': return <EditItem item={item} />;
    case 'error': return <div className="act bad"><span className="aicon bad">!</span><span className="alabel wrap">{item.text}</span></div>;
    default: return null;
  }
}

// ------------------------------------------------------------------- turns

function TurnView({ turn, working, blocked }: { turn: Turn; working: boolean; blocked: boolean }) {
  const d = turn.done;
  return (
    <>
      {(turn.text || turn.attachments?.length) && <div className="turn user"><div className="bubble">{turn.text}{turn.attachments?.map((a,i)=>(<img key={i} src={`data:${a.mime};base64,${a.data}`} alt={a.filename} style={{maxWidth:'100%',borderRadius:8,marginTop:8}} />))}</div></div>}
      <div className="turn assistant">
        {turn.items.map((it) => <ItemView key={it.id} item={it} />)}
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

export function Transcript({ turns, status, loaded, empty }: { turns: Turn[]; status: string; loaded: boolean; empty?: string }) {
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
          {!loaded && <p className="placeholder">Loading the conversation…</p>}
          {loaded && turns.length === 0 && <p className="placeholder">{empty ?? 'Send a message to start the conversation.'}</p>}
          {turns.map((t) => <TurnView key={t.id} turn={t} working={working && t === last} blocked={status === 'blocked'} />)}
        </div>
      </div>
      {unread && <button className="jump" onClick={jump}>↓ new</button>}
    </div>
  );
}
