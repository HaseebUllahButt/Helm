import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { Markdown } from '../Markdown';
import type { Change, Item, Turn } from './types';
import { money, seconds } from '../format';

/**
 * The conversation, live.
 *
 * Text is shown as it lands, without an artificial typing queue. Tool calls are one line each
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


// ------------------------------------------------------------------- items

function TextItem({ item, commandOutput }: { item: Item; commandOutput?: boolean }) {
  const live = item.status === 'streaming';
  const text = item.text;
  if (!text && !live) return null;
  return <Markdown text={text} live={live} className={`prose${commandOutput ? ' command-result' : ''}${live ? ' live' : ''}`} />;
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

/**
 * What a run of finished tool calls did, in a few words - "Read 2 files ·
 * Edited math.js" - in the order it happened. Nobody reads six lines of
 * `Read /home/...` to learn the agent looked at some files.
 */
function stepsSummary(items: Item[]): string {
  const order: string[] = [];
  const count: Record<string, number> = {};
  for (const it of items) {
    const g = toolGlyph(it.name);
    if (!(g in count)) { count[g] = 0; order.push(g); }
    count[g] += 1;
  }
  const many = (n: number, one: string, more: string) => (n === 1 ? one : more.replace('#', String(n)));
  return order.map((g) => {
    const n = count[g];
    if (g === '◎') return many(n, 'Read 1 file', 'Read # files');
    if (g === '✎') return many(n, 'Edited 1 file', 'Edited # files');
    if (g === '❯') return many(n, 'Ran 1 command', 'Ran # commands');
    if (g === '⌕') return many(n, 'Searched', 'Searched # times');
    return many(n, 'Used 1 tool', 'Used # tools');
  }).join(' · ');
}

/** "12s" from the first call to the last, when the timestamps are there. */
function spanOf(items: Item[]): string {
  const start = Math.min(...items.map((i) => i.startedAt).filter(Boolean));
  const end = Math.max(...items.map((i) => i.doneAt ?? i.startedAt).filter(Boolean));
  return Number.isFinite(start) && end - start >= 2000 ? seconds(end - start) : '';
}

/** A picture, full screen: tap to zoom in, tap again to zoom out, scroll to pan. */
function Lightbox({ src, alt, onClose }: { src: string; alt: string; onClose: () => void }) {
  const [big, setBig] = useState(false);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div className="lightbox" onClick={onClose} role="dialog" aria-modal="true" aria-label={alt || 'image'}>
      <div className={`lightbox-pan${big ? ' zoomed' : ''}`}>
        <img src={src} alt={alt} onClick={(e) => { e.stopPropagation(); setBig((v) => !v); }} />
      </div>
      <button className="lightbox-x" onClick={onClose} aria-label="close">×</button>
    </div>
  );
}

function ToolRun({ items, tools, byParent }: { items: Item[]; tools: Item[]; byParent: Map<string, Item[]> }) {
  const failed = tools.filter((i) => i.status === 'error').length;
  return (
    <details className="actgroup steps">
      <summary>
        <span className="aicon">{toolGlyph(tools[0].name)}</span>
        <span className="alabel">{stepsSummary(tools)}{failed ? ` · ${failed} failed` : ''}</span>
        {spanOf(items) && <span className="ameta">{spanOf(items)}</span>}
        <span className="achev">›</span>
      </summary>
      <div className="steps-body">{items.map((it) => <ItemView key={it.id} item={it} byParent={byParent} />)}</div>
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

function ItemView({ item, byParent, commandOutput }: { item: Item; byParent: Map<string, Item[]>; commandOutput?: boolean }) {
  switch (item.kind) {
    case 'text': return <TextItem item={item} commandOutput={commandOutput} />;
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
export function splitNote(text?: string): { note?: string; text?: string } {
  const m = text ? HELM_NOTE.exec(text) : null;
  return m ? { note: m[1], text: m[2] } : { text };
}

/** How long ago a bubble was sent, in the transcript's own quiet type. */
function clock(ts?: number) {
  if (!ts) return '';
  const d = new Date(ts);
  const today = new Date();
  const sameDay = d.toDateString() === today.toDateString();
  const time = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  return sameDay ? time : `${d.toLocaleDateString([], { month: 'short', day: 'numeric' })} ${time}`;
}

function TurnView({ turn, items, head = true, tail = true, working, blocked, onResend, onWithdraw, onBranch }: {
  turn: Turn;
  /**
   * A slice of the turn's items, when it renders around a helm answer hosted
   * inside it: the first slice carries the prompt bubble, the last carries
   * the working pulse and the footer, and the slices between are just items.
   */
  items?: Item[];
  head?: boolean;
  tail?: boolean;
  working: boolean; blocked: boolean; onResend?: (turn: Turn) => void; onWithdraw?: (turn: Turn) => void;
  /** Start a new thread from the conversation as it was before this message. */
  onBranch?: (turn: Turn) => void;
}) {
  const said = splitNote(turn.text);
  // A prompt that is itself a command means the turn's text is that
  // command's answer - styled as a quiet result panel rather than prose.
  const commandOutput = /^\/\S+/.test((said.text ?? '').trim());
  const d = turn.done;
  // New daemons say it outright: `queued` is set on the optimistic turn,
  // false included, so a first send into an idle session never flashes as
  // waiting. The `local-` inference is for old events and old daemons: a
  // turn helm posted that the agent has not echoed is written, queued
  // behind whatever the agent is doing, not yet read by it.
  const queued = turn.queued ?? (turn.id.startsWith('local-') && !d && !turn.items.length);
  // Any turn that ended in an error - whether the message never reached the
  // agent or the turn it became died - is worth offering again: the words
  // are already written, retyping them is the part nobody wants.
  const failed = d?.status === 'error' && !!turn.text;
  // Subagent children hang off their spawn card; a missing parent renders flat.
  const list = items ?? turn.items;
  const ids = new Set(list.map((i) => i.id));
  const byParent = new Map<string, Item[]>();
  const roots = list.filter((it) => {
    if (!it.parentId || !ids.has(it.parentId)) return true;
    const kids = byParent.get(it.parentId) ?? [];
    kids.push(it);
    byParent.set(it.parentId, kids);
    return false;
  });
  return (
    <>
      {head && (turn.text || turn.attachments?.length) && (
        <div className={`turn user${queued ? ' queued' : ''}`}><div className="bubble">
          {said.note && <span className="turn-note">{said.note}</span>}
          {said.text}
          {turn.attachments?.map((a, i) => (a.data
            // A blob the log has swept past still has its name, and saying
            // so beats a browser's broken-image glyph.
            ? <img key={i} className="turn-image" src={`data:${a.mime};base64,${a.data}`} alt={a.filename} title={a.filename} loading="lazy" />
            : <span key={i} className="turn-image-gone" title={a.filename}>🖼 {a.filename || 'image'} — no longer stored</span>
          ))}
          <span className="bubble-meta">
            {queued && <span className="tag">queued</span>}
            {/* Still on helm's side of the wire: the agent has not seen it,
                so taking it back is possible - and puts the words back in
                the composer, the way a CLI lets you pull a queued line up. */}
            {queued && onWithdraw && (
              <button className="withdraw" onClick={() => onWithdraw(turn)}>withdraw</button>
            )}
            {onBranch && !queued && !turn.id.startsWith('local-') && (
              <button className="branch" onClick={() => onBranch(turn)} title="a new thread from before this message" aria-label="branch from before this message">⑂ branch</button>
            )}
            {clock(turn.at)}
          </span>
        </div></div>
      )}
      <div className="turn assistant">
        {(() => {
          // Runs of finished tool calls fold into one line. A run still at
          // the end of a turn in progress stays as lines: the newest call is
          // the news, and a group that re-forms on every call would flicker.
          const nodes: ReactNode[] = [];
          const quiet = (it: Item) => it.kind === 'tool' || it.kind === 'thinking';
          for (let i = 0; i < roots.length;) {
            if (!quiet(roots[i])) {
              nodes.push(<ItemView key={roots[i].id} item={roots[i]} byParent={byParent} commandOutput={commandOutput} />);
              i += 1;
              continue;
            }
            let j = i;
            while (j < roots.length && quiet(roots[j])) j += 1;
            const run = roots.slice(i, j);
            const tools = run.filter((x) => x.kind === 'tool');
            // Thinking rides along in the fold - "Thought" between two reads
            // is not news - but a lone thought with no tool call stays as it is.
            if (tools.length > 0 && run.length > 1 && (d || j < roots.length) && run.every((x) => x.status !== 'streaming')) {
              nodes.push(<ToolRun key={run[0].id} items={run} tools={tools} byParent={byParent} />);
            } else {
              run.forEach((x) => nodes.push(<ItemView key={x.id} item={x} byParent={byParent} commandOutput={commandOutput} />));
            }
            i = j;
          }
          return nodes;
        })()}
        {tail && !d && working && !turn.items.some((it) => it.status === 'streaming' && it.kind === 'text') && (
          blocked
            ? <div className="working quiet">Waiting for you</div>
            : <div className="working"><span className="shine">Working…</span></div>
        )}
        {tail && d && (d.status === 'interrupted' ? <div className="turn-meta">stopped</div>
          : d.status === 'error' ? (
            <div className="turn-meta bad">
              {d.error || 'the turn failed'}
              {failed && onResend && (
                // A message that never reached the agent deserves a way to
                // try again that does not start with retyping it.
                <button className="resend" onClick={() => onResend(turn)}>resend</button>
              )}
            </div>
          )
          : (d.durationMs || d.costUsd) ? <div className="turn-meta">{[seconds(d.durationMs), money(d.costUsd)].filter(Boolean).join(' · ')}</div> : null)}
      </div>
    </>
  );
}

export function Transcript({ turns, status, loaded, empty, earlier, loadingEarlier, onEarlier, onResend, onWithdraw, onBranch }: {
  turns: Turn[]; status: string; loaded: boolean; empty?: string;
  /** The machine holds more of this conversation than is on screen. */
  earlier?: boolean; loadingEarlier?: boolean; onEarlier?: () => void;
  /** Offered on a turn that ended in an error: send its prompt again. */
  onResend?: (turn: Turn) => void;
  /** Offered while a message is still queued: take it back into the draft. */
  onWithdraw?: (turn: Turn) => void;
  /** Offered on every message but the first: branch the conversation from before it. */
  onBranch?: (turn: Turn) => void;
}) {
  const box = useRef<HTMLDivElement>(null);
  const stuck = useRef(true);
  const [unread, setUnread] = useState(false);
  // The working pulse hangs off the turn still being written - with a helm
  // answer hosted mid-turn, that is not necessarily the last turn in the list.
  const openTurn = turns.filter((t) => !t.done).at(-1);
  const working = status === 'working' || status === 'blocked';

  const onScroll = () => {
    const el = box.current;
    if (!el) return;
    stuck.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    if (stuck.current) setUnread(false);
  };
  // Runs on every render, but only *growth* is news: a keystroke in the
  // composer re-renders this too, and used to raise "↓ new" for nothing. Older
  // turns arriving above keep the reader where they were - iOS Safari has no
  // scroll anchoring to do it for us.
  const seen = useRef<{ h: number; first?: string }>({ h: 0 });
  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    const h = el.scrollHeight;
    const first = turns[0]?.id;
    const prev = seen.current;
    seen.current = { h, first };
    if (stuck.current) el.scrollTop = h;
    else if (prev.first !== undefined && first !== prev.first) el.scrollTop += h - prev.h;
    else if (h > prev.h) setUnread(true);
  });

  /** Jump to the previous or next thing you asked - the landmarks of a long thread. */
  const step = (dir: -1 | 1) => {
    const el = box.current;
    if (!el) return;
    const base = el.getBoundingClientRect().top - el.scrollTop;
    const ys = [...el.querySelectorAll<HTMLElement>('.turn.user')].map((n) => n.getBoundingClientRect().top - base);
    const here = el.scrollTop;
    const target = dir < 0 ? [...ys].reverse().find((y) => y < here - 12) : ys.find((y) => y > here + 12);
    if (target == null) { el.scrollTo({ top: dir < 0 ? 0 : el.scrollHeight, behavior: 'smooth' }); return; }
    stuck.current = false;
    el.scrollTo({ top: Math.max(0, target - 10), behavior: 'smooth' });
  };
  const prompts = turns.filter((t) => t.text).length;
  const [zoom, setZoom] = useState<{ src: string; alt: string } | null>(null);

  const jump = () => {
    const el = box.current;
    if (el) { el.scrollTop = el.scrollHeight; stuck.current = true; setUnread(false); }
  };

  // A helm answer that landed inside a still-running turn renders at the seam
  // it recorded (insideOf/insideAt): the host's items up to the seam above it,
  // the rest below - the running turn's output flows under the answer instead
  // of piling up over it. One whose host is not on screen just sits where it
  // was appended.
  const turnIds = new Set(turns.map((t) => t.id));
  const insideByHost = new Map<string, Turn[]>();
  const hostedIds = new Set<string>();
  for (const t of turns) {
    if (!t.insideOf || !turnIds.has(t.insideOf)) continue;
    insideByHost.set(t.insideOf, [...(insideByHost.get(t.insideOf) ?? []), t]);
    hostedIds.add(t.id);
  }
  const view = (t: Turn, items?: Item[], head = true, tail = true, key: string = t.id) => (
    <TurnView key={key} turn={t} items={items} head={head} tail={tail}
      working={working && t === openTurn} blocked={status === 'blocked'}
      onResend={onResend} onWithdraw={onWithdraw}
      onBranch={onBranch && turns.indexOf(t) > 0 ? onBranch : undefined} />
  );
  const flow: ReactNode[] = [];
  for (const t of turns) {
    if (hostedIds.has(t.id)) continue;
    const hosted = insideByHost.get(t.id)?.sort((a, b) => (a.insideAt ?? 0) - (b.insideAt ?? 0));
    if (!hosted?.length) { flow.push(view(t)); continue; }
    let prev = 0;
    hosted.forEach((c, k) => {
      const cut = Math.max(prev, Math.min(c.insideAt ?? t.items.length, t.items.length));
      if (k === 0 || cut > prev) flow.push(view(t, t.items.slice(prev, cut), k === 0, false, `${t.id}#${k}`));
      flow.push(view(c));
      prev = cut;
    });
    flow.push(view(t, t.items.slice(prev), false, true, `${t.id}#end`));
  }

  return (
    <div className="chat-wrap">
      <div className="chat" ref={box} onScroll={onScroll}>
        <div className="timeline" onClick={(e) => {
          const img = (e.target as HTMLElement).closest?.('img.turn-image') as HTMLImageElement | null;
          if (img) setZoom({ src: img.src, alt: img.alt });
        }}>
          {/* A chat opens on its last screenful, because that is what you came
              for; the rest of it is a tap away rather than a wait. */}
          {loaded && earlier && (
            <button className="earlier" onClick={onEarlier} disabled={loadingEarlier}>
              {loadingEarlier ? 'reading…' : 'Earlier in this conversation'}
            </button>
          )}
          {!loaded && <p className="placeholder">Loading the conversation…</p>}
          {loaded && turns.length === 0 && <p className="placeholder">{empty ?? 'Send a message to start the conversation.'}</p>}
          {flow}
        </div>
      </div>
      {unread && <button className="jump" onClick={jump}>↓ new</button>}
      {prompts >= 3 && (
        <div className="turnnav" role="group" aria-label="jump between your messages">
          <button onClick={() => step(-1)} aria-label="previous message of yours" title="previous message">▲</button>
          <button onClick={() => step(1)} aria-label="next message of yours" title="next message">▼</button>
        </div>
      )}
      {zoom && <Lightbox src={zoom.src} alt={zoom.alt} onClose={() => setZoom(null)} />}
    </div>
  );
}
