import { useCopySelection } from '../useCopySelection';
import { createContext, Fragment, useContext, memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Markdown } from '../Markdown';
import type { Change, Item, Turn, Permission } from './types';
import { seconds } from '../format';
import { Icon, toolKind, type IconName } from '../Icon';
import { userMessage } from './userMessage';
import { splitAgentMessage, helperMessage } from './agentMessage';
import { stripBrief } from '@helm/protocol/brief';
import { plainError } from './problem';
import { VisualReply, Visuals, type VisualReader } from './VisualReply';
import { ContextCard } from './ContextCard';
import { TodoCard, isTodoItem, parseTodos } from './Todos';
import { parseContextUsage } from './contextUsage';
import { Reveal, WorkingLine, ChangedFiles, changedFiles, testResult } from './TurnPulse';
import { stepWords, thoughtBody, thoughtTitle, toolSummary, tryParse, rawCommand, toolChanges, changesOf, changeStats, unifiedDiff, diffCounts } from './stepWords';
import { money } from '../format';

/** The session is still working, so an open compaction is really running. */
const Busy = createContext(false);

/** A CLI shrinking its context - every engine's compaction is this one item. */
export const isCompaction = (it: Item) => it.kind === 'tool' && (it.name === 'compact' || it.name === 'contextCompaction');

/** The line a compaction draws across the conversation, live while it runs. */
export function CompactionLine({ live, item }: { live: boolean; item?: Item }) {
  const took = item?.doneAt && item.startedAt ? item.doneAt - item.startedAt : 0;
  const label = live ? 'Compacting conversation…'
    : item?.status === 'error' ? 'Compaction failed'
      : item?.status === 'declined' ? 'Compaction stopped'
        : item?.status === 'streaming' ? 'Compaction interrupted'
          : `Conversation compacted${took > 2000 ? ` · ${seconds(took)}` : ''}`;
  return (
    <div className={`compaction${live ? ' live' : ''}${item?.status === 'error' ? ' bad' : ''}`} title={item?.error || undefined} role={live ? 'status' : undefined}>
      <span className={live ? 'shine' : undefined}>{label}</span>
    </div>
  );
}

function CompactItem({ item }: { item: Item }) {
  const busy = useContext(Busy);
  return <CompactionLine live={item.status === 'streaming' && busy} item={item} />;
}

type ItemFocus = { id: string; visit: number; start?: boolean };
/** Opens the chat of the helper a spawn step started, when Helm knows that helper. */
const OpenAgent = createContext<((item: Item) => (() => void) | null) | undefined>(undefined);
const Requests = createContext<{ pending: Permission[]; review?: (id: string) => void; focusItem?: ItemFocus }>({ pending: [] });

/**
 * The conversation, live.
 *
 * Text is shown as it lands, without an artificial typing queue. Tool calls are one line each
 * while they run and fold their output away when they finish; commands and
 * file changes get a little more room because what they did is the point.
 */

/** A tool call's icon, by what kind of thing it did. */
const ToolIcon = ({ name = '' }: { name?: string }) => <Icon name={toolKind(name)} size={15} />;

const shortPath = (p = '') => {
  const parts = p.replace(/\/$/, '').split('/');
  return parts.length > 3 ? '…/' + parts.slice(-2).join('/') : p;
};


// ------------------------------------------------------------------- items

function TextItem({ item, commandOutput }: { item: Item; commandOutput?: boolean }) {
  const live = item.status === 'streaming';
  const text = item.text;
  if (!text && !live) return null;
  const context = commandOutput && !live ? parseContextUsage(text) : null;
  if (context) return <ContextCard usage={context} />;
  return <Markdown text={text} live={live} className={`prose${commandOutput ? ' command-result' : ''}${live ? ' live' : ''}`} />;
}

function ThinkingItem({ item }: { item: Item }) {
  const live = item.status === 'streaming';
  const took = item.doneAt && item.startedAt ? item.doneAt - item.startedAt : 0;
  const label = thoughtTitle(item.text) ?? (live ? 'Thinking' : took > 1500 ? `Thought for ${seconds(took)}` : 'Thought');
  if (!live && !item.text) return <div className="act quiet"><span className="aicon"><Icon name="think" size={15} /></span><span className="alabel">{label}</span></div>;
  return (
    <details className="actgroup think">
      <summary>
        <span className="aicon"><Icon name="think" size={15} /></span>
        <span className={`alabel${live ? ' shine' : ''}`}>{label}</span>
        {item.text && <span className="achev"><Icon name="forward" size={13} /></span>}
      </summary>
      {item.text && <div className="think-body">{thoughtBody(item.text)}</div>}
    </details>
  );
}

function ToolItem({ item }: { item: Item }) {
  const live = item.status === 'streaming';
  const summary = toolSummary(item);
  const out = item.output ?? '';
  const body = out || item.error;
  const head = (
    <>
      <span className={`aicon${item.status === 'error' ? ' bad' : item.status === 'ok' ? ' done' : ''}`}><ToolIcon name={item.name} /></span>
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
      <summary>{head}<span className="achev"><Icon name="forward" size={13} /></span></summary>
      <pre className="aout">{body.length > 4000 ? body.slice(0, 4000) + '\n…' : body}</pre>
    </details>
  );
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
      <button className="lightbox-x" onClick={onClose} aria-label="close"><Icon name="close" size={20} /></button>
    </div>
  );
}

// ------------------------------------------------------------------- steps

const isTextish = (it: Item) => it.kind === 'text' || it.kind === 'visual';
/** Errors and compactions stay out in the open; they are not "work". */
const isApart = (it: Item) => it.kind === 'error' || isCompaction(it);
const isFailed = (it: Item) => it.status === 'error' || (it.kind === 'command' && it.exitCode != null && it.exitCode !== 0);

function stepIcon(it: Item): IconName {
  if (it.kind === 'command' && it.actions?.length && it.actions.every((a) => a.type === it.actions![0].type)) {
    const t = it.actions[0].type;
    if (t === 'read') return 'read';
    if (t === 'search' || t === 'listFiles' || t === 'list_files') return 'search';
  }
  return it.kind === 'command' ? 'run' : it.kind === 'edit' ? 'edit' : it.kind === 'thinking' ? 'think'
    : it.kind === 'subagent' ? 'subagents' : isTodoItem(it) ? 'plan' : toolKind(it.name ?? '');
}

/**
 * A finished thought with nothing in it. Codex thinks before nearly every
 * command and only shares notes when asked, so these were most of its steps
 * and pushed what it said off the screen.
 */
const blankThought = (it: Item) => it.kind === 'thinking' && it.status !== 'streaming' && !it.text?.trim();

/** Rows are for plain steps; a helper keeps its own card, and prose stays prose. */
const rowable = (it: Item) => !isTextish(it) && !isApart(it) && it.kind !== 'subagent';

/** What opening a step shows: the raw command and what it printed, the diff, the list. */
function hasDetail(it: Item): boolean {
  if (it.kind === 'command' || rawCommand(it) !== undefined) return true;
  if (it.kind === 'edit') return (it.changes ?? []).length > 0;
  if (isTodoItem(it)) return !!parseTodos(it);
  if (it.kind === 'thinking') return !!it.text;
  return changesOf(it).length > 0 || !!(it.output || it.error);
}

function StepDetail({ item, byParent }: { item: Item; byParent: Map<string, Item[]> }) {
  const command = rawCommand(item);
  const out = (item.output ?? item.text ?? '').replace(/\s+$/, '');
  const body = out || item.error || '';
  const raw = body.length > 4000 ? '…\n' + body.slice(-4000) : body;
  if (command !== undefined) {
    return (
      <div className="step-raw">
        <code className="step-cmd">{command}</code>
        {raw && <pre className="cmd-out">{raw}</pre>}
        {item.exitCode != null && item.exitCode !== 0 && <div className="step-exit">exit {item.exitCode}</div>}
      </div>
    );
  }
  if (item.kind === 'edit' || changesOf(item).length) return <ItemContent item={item} byParent={byParent} />;
  if (isTodoItem(item)) return <TodoCard item={item} />;
  if (item.kind === 'thinking') return <div className="think-body">{thoughtBody(item.text)}</div>;
  const summary = toolSummary(item);
  return (
    <div className="step-raw">
      <code className="step-cmd"><b>{item.name}</b>{summary && <> {summary}</>}</code>
      {raw && <pre className="aout">{raw}</pre>}
    </div>
  );
}

/**
 * One step as one quiet line, in plain words: "Ran tests", "Read app.ts".
 * Running, it shines; failed, it carries a small red x; tap it for the
 * raw command and what it printed.
 */
function StepRow({ item, byParent }: { item: Item; byParent: Map<string, Item[]> }) {
  const { focusItem } = useContext(Requests);
  const [open, setOpen] = useState(false);
  useEffect(() => { if (focusItem?.id === item.id) setOpen(true); }, [focusItem]);
  const words = stepWords(item);
  const live = item.status === 'streaming';
  const failed = isFailed(item);
  const detail = hasDetail(item);
  const changes = changesOf(item);
  const stats = !live && changes.length ? changeStats(changes) : null;
  return (
    <div className={`step${failed ? ' bad' : ''}${open ? ' open' : ''}`}>
      <button type="button" className="step-head" disabled={!detail} aria-expanded={detail ? open : undefined} onClick={() => setOpen((v) => !v)}>
        <span className={`aicon${failed ? ' bad' : ''}`}><Icon name={stepIcon(item)} size={15} /></span>
        <span className={`alabel${live ? ' shine' : ''}`}>{live ? words.now : words.past}</span>
        {stats && (stats.add > 0 || stats.del > 0) && <span className="ameta"><i className="add">+{stats.add}</i> <i className="del">−{stats.del}</i></span>}
        {live && item.elapsed != null && item.elapsed > 2 && <span className="ameta">{Math.round(item.elapsed)}s</span>}
        {item.status === 'declined' && <span className="ameta">declined</span>}
        {failed && <span className="step-x" role="img" aria-label="failed"><Icon name="close" size={12} /></span>}
        {detail && <span className={`achev${open ? ' open' : ''}`}><Icon name="forward" size={13} /></span>}
      </button>
      {open && <StepDetail item={item} byParent={byParent} />}
    </div>
  );
}

/** How many steps of a running turn stay on screen. */
const LIVE_STEPS = 3;

/**
 * Everything the agent did before its answer. While it works: a "Working
 * for 42s" line and its newest few steps, one plain line each. When it is
 * done the same block becomes one quiet "Worked for 8m 41s" row that opens
 * to everything, in order. One block per turn, so nothing jumps.
 */
function Work({ turn, items, byParent, live, label, blocked }: {
  turn: Turn; items: Item[]; byParent: Map<string, Item[]>; live: boolean; label: string; blocked: boolean;
}) {
  const [open, setOpen] = useState(false);
  const requests = useContext(Requests);
  const ids = new Set(items.map((item) => item.id));
  const collect = (id: string) => { for (const child of byParent.get(id) ?? []) if (!ids.has(child.id)) { ids.add(child.id); collect(child.id); } };
  items.forEach((item) => collect(item.id));
  useEffect(() => { if (requests.focusItem && ids.has(requests.focusItem.id)) setOpen(true); }, [requests.focusItem]);
  const asking = requests.pending.filter((request) => request.parentId && ids.has(request.parentId));
  const helper = items.some((item) => item.kind === 'subagent' && ['running', 'pendingInit', 'working'].includes(item.agent?.status ?? ''));
  const ask = (list: Permission[]) => requests.review && list.map((request) => (
    <button key={request.requestId} className="subagent-request" onClick={() => requests.review?.(request.requestId)}>
      {request.kind === 'question' ? 'Answer question' : 'Review request'} · {request.title}<Icon name="forward" size={13} />
    </button>
  ));

  if (live) {
    const stepAt = items.flatMap((it, i) => (isTextish(it) ? [] : [i]));
    const hidden = open ? 0 : Math.max(0, stepAt.length - LIVE_STEPS);
    const from = hidden ? stepAt[stepAt.length - LIVE_STEPS] : 0;
    const shown = items.slice(from);
    // The last thing it said stays in view while newer steps scroll past.
    let lastSaid = items.length - 1;
    while (lastSaid >= 0 && !(items[lastSaid].kind === 'text' && items[lastSaid].text?.trim())) lastSaid -= 1;
    const said = hidden && lastSaid >= 0 && lastSaid < from ? items[lastSaid] : null;
    // A helper's card on screen carries its own "Answer question" button;
    // a second one here would be the same request twice.
    const cards = new Set(shown.filter((it) => it.kind === 'subagent').map((it) => it.id));
    const unseen = asking.filter((request) => !cards.has(request.parentId ?? ''));
    return (
      <div className={`work live${open ? ' open' : ''}`}>
        <WorkingLine turn={turn} blocked={blocked} />
        {hidden > 0 && <button type="button" className="steps-earlier" aria-expanded={false} onClick={() => setOpen(true)}>+{hidden} earlier {hidden === 1 ? 'step' : 'steps'}</button>}
        {open && stepAt.length > LIVE_STEPS && <button type="button" className="steps-earlier" aria-expanded onClick={() => setOpen(false)}>Show fewer steps</button>}
        <div className="steps-live">
          {said && <div key={said.id} className="live-step"><ItemView item={said} byParent={byParent} plain /></div>}
          {shown.map((it) => <div key={it.id} className="live-step"><ItemView item={it} byParent={byParent} plain /></div>)}
        </div>
        {ask(unseen)}
      </div>
    );
  }
  return (
    <div className={`work${open ? ' open' : ''}`}>
      <button type="button" className="work-head" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
        <span className={`work-label${helper ? ' shine' : ''}`}>{label}</span>
        <span className={`achev${open ? ' open' : ''}`}><Icon name="forward" size={13} /></span>
      </button>
      {!open && ask(asking)}
      {open && <div className="steps-body">{items.map((it) => <ItemView key={it.id} item={it} byParent={byParent} />)}</div>}
    </div>
  );
}

function CommandItem({ item }: { item: Item }) {
  const live = item.status === 'streaming';
  const out = (item.output ?? item.text ?? '').replace(/\s+$/, '');
  const lines = out ? out.split('\n') : [];
  // Output is folded until asked for: the command says what happened, and
  // a wall of its output is what made a conversation unreadable. While it
  // runs, its last few lines show it is alive.
  const [open, setOpen] = useState(false);
  const shown = open ? lines : live ? lines.slice(-3) : [];
  return (
    <div className={`cmd${item.status === 'error' ? ' bad' : ''}`}>
      <button type="button" className="cmd-head" disabled={!lines.length} aria-expanded={lines.length ? open : undefined}
        onClick={() => setOpen((v) => !v)}>
        <span className={`aicon${item.status === 'error' ? ' bad' : !live && item.exitCode === 0 ? ' done' : ''}`}><Icon name="run" size={15} /></span>
        <code className={`cmd-line${live ? ' shine' : ''}`}>{item.command}</code>
        {item.status === 'declined' && <span className="ameta">declined</span>}
        {item.exitCode != null && item.exitCode !== 0 && <span className="ameta bad">exit {item.exitCode}</span>}
        {live && item.elapsed != null && item.elapsed > 2 && <span className="ameta">{Math.round(item.elapsed)}s</span>}
        {!live && lines.length > 0 && <span className="ameta">{lines.length} {lines.length === 1 ? 'line' : 'lines'}</span>}
        {!live && item.exitCode === 0 && <span className="ameta ok" aria-label="succeeded"><Icon name="check" size={12} /></span>}
        {lines.length > 0 && !live && <span className={`achev${open ? ' open' : ''}`}><Icon name="forward" size={13} /></span>}
      </button>
      {shown.length > 0 && <pre className="cmd-out">{shown.join('\n')}</pre>}
    </div>
  );
}

export function Diff({ text }: { text: string }) {
  return (
    <pre className="diff">
      {text.split('\n').map((l, i) => (
        <span key={i} className={l.startsWith('+') ? 'add' : l.startsWith('-') ? 'del' : l.startsWith('@@') ? 'hunk' : ''}>{l}{'\n'}</span>
      ))}
    </pre>
  );
}

type DiffRow = { kind: 'add' | 'del' | 'ctx' | 'hunk'; text: string };

/** A diff as rows to draw: the file header lines are dropped, since the card
 *  already names the file, and each @@ line becomes a separator. */
const diffRows = (diff: string): DiffRow[] => {
  const rows: DiffRow[] = [];
  let head = true;
  for (const l of diff.split('\n')) {
    // Header lines only come before the first hunk; later on a removed
    // "-- comment" really starts with three dashes.
    if (head && /^(diff |index |--- |\+\+\+ |new file|deleted file|similarity|rename |old mode|new mode)/.test(l)) continue;
    if (l.startsWith('@@')) { head = false; if (rows.length) rows.push({ kind: 'hunk', text: '' }); continue; }
    head = false;
    if (l.startsWith('\\')) continue; // "\ No newline at end of file"
    rows.push(l.startsWith('+') ? { kind: 'add', text: l.slice(1) } : l.startsWith('-') ? { kind: 'del', text: l.slice(1) } : { kind: 'ctx', text: l.startsWith(' ') ? l.slice(1) : l });
  }
  // A trailing newline leaves one empty context row behind.
  while (rows.length && rows[rows.length - 1].kind === 'ctx' && !rows[rows.length - 1].text) rows.pop();
  return rows;
};

const PREVIEW_CHANGES = 8;
const isChange = (r: DiffRow) => r.kind === 'add' || r.kind === 'del';

/** The first few changed lines with one line of context either side - enough
 *  to see what happened without opening anything. */
const previewRows = (rows: DiffRow[]) => {
  const first = rows.findIndex(isChange);
  if (first < 0) return rows.slice(0, PREVIEW_CHANGES);
  let end = first, seen = 0;
  for (; end < rows.length; end++) {
    if (isChange(rows[end])) { if (seen === PREVIEW_CHANGES) break; seen++; }
  }
  // One line of context after the last changed line, but not a separator.
  if (rows[end]?.kind === 'ctx') end++;
  const window = rows.slice(Math.max(0, first - 1), end);
  // Hiding a line or two is not worth a toggle.
  return rows.length - window.length <= 2 ? rows : window;
};

const rowSign = { add: '+', del: '−', ctx: '', hunk: '' };

function DiffPreview({ rows }: { rows: DiffRow[] }) {
  const [all, setAll] = useState(false);
  if (!rows.length) return null;
  const preview = previewRows(rows);
  const shown = all ? rows : preview;
  const total = rows.filter((r) => r.kind !== 'hunk').length;
  return (
    <div className="idiff">
      <div className={`idiff-box${all ? ' all' : ''}`}>
        <div className="idiff-in">
          {shown.map((r, i) => r.kind === 'hunk'
            ? <div key={i} className="idiff-gap" aria-hidden="true" />
            : <div key={i} className={`idiff-row ${r.kind}`}><i>{rowSign[r.kind]}</i><code>{r.text || ' '}</code></div>)}
        </div>
      </div>
      {preview.length < rows.length && (
        <button type="button" className="idiff-more" aria-expanded={all} onClick={() => setAll((v) => !v)}>
          {all ? 'Show fewer' : `Show all ${total} lines`}
        </button>
      )}
    </div>
  );
}

function ChangeCard({ c, open, preview }: { c: Change; open: boolean; preview: boolean }) {
  // Codex sends an added file as its content, not a unified diff.
  const shown = unifiedDiff(c);
  const { add, del } = diffCounts(shown);
  return (
    <details className={`edit${preview ? ' previewed' : ''}`} open={open || preview}>
      <summary>
        <span className="aicon"><Icon name="edit" size={15} /></span>
        <span className="alabel"><b>{c.kind === 'add' ? 'Create' : c.kind === 'delete' ? 'Delete' : 'Edit'}</b> {shortPath(c.path)}</span>
        <span className="ameta"><i className="add">+{add}</i> <i className="del">−{del}</i></span>
        <span className="achev"><Icon name="forward" size={13} /></span>
      </summary>
      {preview ? <DiffPreview rows={diffRows(shown)} /> : <Diff text={shown} />}
    </details>
  );
}

/** `preview` draws the change right in the chat; the permission sheet keeps
 *  the plain full diff. */
export function ChangeList({ changes, open = false, preview = false }: { changes: Change[]; open?: boolean; preview?: boolean }) {
  return <>{changes.map((c, i) => <ChangeCard key={i} c={c} open={open} preview={preview} />)}</>;
}

function EditItem({ item }: { item: Item }) {
  const changes = changesOf(item);
  if (!changes.length) return <div className="act"><span className="aicon"><Icon name="edit" size={15} /></span><span className="alabel"><b>Edit</b></span></div>;
  return <div className={`edits${item.status === 'declined' ? ' declined' : item.status === 'error' ? ' bad' : ''}`}><ChangeList changes={changes} preview /></div>;
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
  const live = item.agent?.status ? ['running', 'pendingInit', 'working'].includes(item.agent.status) : item.status === 'streaming';
  const requests = useContext(Requests);
  const open = useContext(OpenAgent)?.(item);
  const request = requests.pending.find(p => p.parentId === item.id);
  const input = item.input ?? tryParse(item.inputJson);
  const who = input?.subagent_type ?? item.name ?? 'subagent';
  const task = input?.description ?? input?.prompt ?? item.agent?.description ?? '';
  const kids = byParent.get(item.id) ?? [];
  const out = item.output ?? item.agent?.summary ?? '';
  const used = tokens(item.agent?.tokens);
  const calls = item.agent?.toolUses;
  const model = input?.model ?? item.agent?.model;
  // While it runs, what it is doing now beats what it was asked: the engine
  // rewrites `description` as the child works, and nothing showed it.
  const doing = live && item.agent?.description ? item.agent.description : task;
  const head = (
    <>
      <span className={`aicon${item.status === 'error' ? ' bad' : ''}`}><Icon name="subagents" size={15} /></span>
      <span className={`alabel${live ? ' shine' : ''}`}>
        <b>{who}</b>{doing && <> {typeof doing === 'string' && doing.length > 140 ? doing.slice(0, 140) + '…' : String(doing)}</>}
      </span>
      {live && item.agent?.lastTool && <span className="ameta">{item.agent.lastTool}</span>}
      {model && <span className="ameta">{String(model)}</span>}
      {!live && !!calls && <span className="ameta">{calls} {calls === 1 ? 'tool' : 'tools'}</span>}
      {used && <span className="ameta">{used}</span>}
      {live && item.elapsed != null && item.elapsed > 2 && <span className="ameta">{Math.round(item.elapsed)}s</span>}
      {item.status === 'error' && <span className="ameta bad">failed</span>}
      {item.status === 'declined' && <span className="ameta">stopped</span>}
      {request && requests.review && <button className="subagent-request" onClick={event => {
        event.preventDefault(); event.stopPropagation(); requests.review?.(request.requestId);
      }}>{request.kind === 'question' ? 'Answer question' : 'Review request'}<Icon name="forward" size={13} /></button>}
      {open && !request && <button className="subagent-request subagent-open" onClick={event => {
        event.preventDefault(); event.stopPropagation(); open();
      }}>Open<Icon name="forward" size={13} /></button>}
    </>
  );
  if (!kids.length && !out) return <div className="act">{head}</div>;
  return (
    <details className="actgroup subagent" open={live || undefined}>
      <summary>{head}<span className="achev"><Icon name="forward" size={13} /></span></summary>
      <div className="sub-body">
        {kids.map((k) => <ItemView key={k.id} item={k} byParent={byParent} />)}
        {out && <pre className="aout">{out.length > 4000 ? out.slice(0, 4000) + '\n…' : out}</pre>}
      </div>
    </details>
  );
}

/** A to-do update among the steps: one line that opens to the checklist as it stood. */
function TodoStep({ item }: { item: Item }) {
  const words = stepWords(item);
  if (!parseTodos(item)) return <div className="act"><span className="aicon"><Icon name="plan" size={15} /></span><span className="alabel">{words.past}</span></div>;
  return (
    <details className="actgroup">
      <summary><span className="aicon"><Icon name="plan" size={15} /></span><span className="alabel">{words.past}</span><span className="achev"><Icon name="forward" size={13} /></span></summary>
      <TodoCard item={item} />
    </details>
  );
}

/** A failure, said plainly; what the CLI printed is one tap away. */
function ErrorLine({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  const plain = plainError(text);
  const differs = plain !== text.trim();
  return (
    <div className="act bad errline">
      <span className="aicon bad"><Icon name="alert" size={15} /></span>
      <span className="alabel wrap">
        {plain}
        {differs && <button className="errline-more" aria-expanded={open} onClick={() => setOpen(!open)}>{open ? 'Hide details' : 'Details'}</button>}
        {open && <pre className="errline-raw">{text}</pre>}
      </span>
    </div>
  );
}

type ItemProps = { item: Item; byParent: Map<string, Item[]>; commandOutput?: boolean; plain?: boolean };

/** `plain` draws a plain step as one line of plain words; a finished turn's list keeps the full cards. */
function ItemView(props: ItemProps) {
  // Items change in place, so the revision is passed on by value: it is
  // what tells a step that only the reply around it grew to skip drawing.
  return <ItemBody {...props} revision={props.item.revision} />;
}

/** Whether both maps hold the same items under `id`, all the way down. A
 * change inside one already moves the revision of every card it sits in. */
function sameKids(a: Map<string, Item[]>, b: Map<string, Item[]>, id: string): boolean {
  const x = a.get(id), y = b.get(id);
  if (x === y) return true;
  if (!x || !y || x.length !== y.length) return false;
  return x.every((kid, i) => kid === y[i] && sameKids(a, b, kid.id));
}

const ItemBody = memo(function ItemBody({ item, byParent, commandOutput, plain }: ItemProps & { revision?: number }) {
  const ref = useRef<HTMLDivElement>(null);
  const { focusItem } = useContext(Requests);
  useEffect(() => {
    if (!focusItem || focusItem.id !== item.id || !ref.current) return;
    const element = ref.current;
    for (let parent = element.parentElement; parent; parent = parent.parentElement) {
      if (parent instanceof HTMLDetailsElement) parent.open = true;
    }
    const details = element.querySelector('details');
    if (details) details.open = true;
    element.scrollIntoView({ block: focusItem.start ? 'start' : 'center' });
    element.focus({ preventScroll: true });
  }, [focusItem]);
  return (
    <div ref={ref} data-item-id={item.id} tabIndex={-1}>
      {plain && rowable(item) ? <StepRow item={item} byParent={byParent} /> : <ItemContent item={item} byParent={byParent} commandOutput={commandOutput} />}
    </div>
  );
}, (a, b) => a.item === b.item && a.revision === b.revision && a.commandOutput === b.commandOutput
  && a.plain === b.plain && sameKids(a.byParent, b.byParent, b.item.id));

function ItemContent({ item, byParent, commandOutput }: { item: Item; byParent: Map<string, Item[]>; commandOutput?: boolean }) {
  switch (item.kind) {
    case 'text': return <TextItem item={item} commandOutput={commandOutput} />;
    case 'visual': return item.visual ? <VisualReply visual={item.visual} /> : null;
    case 'thinking': return <ThinkingItem item={item} />;
    case 'tool':
      if (isTodoItem(item)) return <TodoStep item={item} />;
      if (isCompaction(item)) return <CompactItem item={item} />;
      return toolChanges(item).length ? <EditItem item={item} /> : <ToolItem item={item} />;
    case 'command': return <CommandItem item={item} />;
    case 'edit': return <EditItem item={item} />;
    case 'subagent': return <SubagentItem item={item} byParent={byParent} />;
    case 'error': return <ErrorLine text={item.text ?? ''} />;
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
const HELM_NOTE = /^((?:\[helm [^\]\n]*\]\n\n)+)([\s\S]*)$/;
export function splitNote(text?: string): { note?: string; text?: string } {
  if (text) text = stripBrief(text);
  const m = text ? HELM_NOTE.exec(text) : null;
  const shown = splitAgentMessage(m ? m[2] : text);
  const note = [m?.[1].trim(), shown.note].filter(Boolean).join('\n');
  return note ? { note, text: shown.text } : shown;
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

/** How long the work took, from the turn's start (or the first step) to the last step's end. */
function workSpan(turn: Turn, work: Item[], whole: boolean): number {
  const starts = work.map((i) => i.startedAt).filter(Boolean);
  const first = whole && Number.isFinite(turn.at) && turn.at ? turn.at : Math.min(...starts);
  const last = Math.max(...work.map((i) => i.doneAt ?? i.startedAt).filter(Boolean));
  return Number.isFinite(first) && Number.isFinite(last) && last > first ? last - first : 0;
}

/** Under the answer, quietly: a copy button, what it cost, whether the tests passed. */
function FinalMeta({ text, cost, tests }: { text: string; cost?: number; tests: 'passed' | 'failed' | null }) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout>>();
  useEffect(() => () => clearTimeout(timer.current), []);
  const price = money(cost);
  if (!text && !price && !tests) return null;
  const copy = () => {
    void navigator.clipboard?.writeText(text).then(() => {
      setCopied(true);
      clearTimeout(timer.current);
      timer.current = setTimeout(() => setCopied(false), 1500);
    }).catch(() => {});
  };
  return (
    <div className="turn-meta final-meta">
      {text && (
        <button type="button" className="copy-answer" onClick={copy} aria-label={copied ? 'Copied' : 'Copy answer'} title={copied ? 'Copied' : 'Copy answer'}>
          <Icon name={copied ? 'check' : 'copy'} size={14} />
        </button>
      )}
      {price && <span>{price}</span>}
      {tests && <span className={tests === 'failed' ? 'bad' : undefined}>tests {tests}</span>}
    </div>
  );
}

const TurnView = memo(function TurnView({ turn, items, head = true, tail = true, saidBelow = false, working, blocked, onResend, onWithdraw, onBranch, onRewind }: {
  turn: Turn;
  revision?: number;
  /**
   * A slice of the turn's items, when it renders around a helm answer hosted
   * inside it: the first slice carries the prompt bubble, the last carries
   * the working pulse and the footer, and the slices between are just items.
   */
  items?: Item[];
  /** The next turn is only this one's error line, which already says why. */
  saidBelow?: boolean;
  head?: boolean;
  tail?: boolean;
  working: boolean; blocked: boolean; onResend?: (turn: Turn) => void; onWithdraw?: (turn: Turn) => void;
  /** Start a new thread from the conversation as it was before this message. */
  onBranch?: (turn: Turn) => void;
  onRewind?: (turn: Turn) => void;
}) {
  const said = splitNote(turn.text);
  const helper = helperMessage(turn.text);
  const display = userMessage(said.text, turn.attachments);
  said.text = display.text;
  // A prompt that is itself a command means the turn's text is that
  // command's answer - styled as a quiet result panel rather than prose.
  const commandOutput = /^\/\S+/.test((said.text ?? '').trim());
  // An answer with no question - what a command printed, like "Set model
  // to opus" - is a quiet line of text, never a message from the owner.
  const note = turn.local && !turn.text && !turn.attachments?.length;
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
    if (blankThought(it)) return false;
    if (!it.parentId || !ids.has(it.parentId)) return true;
    const kids = byParent.get(it.parentId) ?? [];
    kids.push(it);
    byParent.set(it.parentId, kids);
    return false;
  });
  // The agent's answer is what it said last. Everything before that - the
  // steps and the thinking out loud between them - is "work", and folds.
  // Errors and compactions are neither: they stay where anyone can see them.
  let cut = roots.length;
  while (cut > 0 && (isTextish(roots[cut - 1]) || isApart(roots[cut - 1]))) cut -= 1;
  let pre = roots.slice(0, cut);
  let answer = roots.slice(cut);
  // A terminal chat's own history can file a helper's card after the reply
  // it led to. Once the turn is over, the last thing said is still the answer.
  if (d && !answer.some((it) => it.kind === 'text' && !!it.text)) {
    let k = pre.length - 1;
    while (k >= 0 && !(pre[k].kind === 'text' && pre[k].text)) k -= 1;
    if (k >= 0) { answer = [pre[k], ...answer]; pre = [...pre.slice(0, k), ...pre.slice(k + 1)]; }
    // A long chat keeps only its latest part, so an old turn can lose its
    // words and keep just a helper's card. Folding that away left an empty
    // "Worked for" row: show what is left instead.
    else if (d.status === 'ok') { answer = [...pre, ...answer]; pre = []; }
  }
  // A picture the agent drew (helm render, its own or a helper's), an error
  // and a compaction line stay out in the open, in order: the steps around
  // them split into one block before and one after, so newer steps land
  // below them like the rest of a chat instead of piling up above.
  const pinned = (it: Item) => it.kind === 'visual' || isApart(it);
  const work = pre.filter((it) => !pinned(it));
  const blocks: { work: Item[]; after: Item[] }[] = [{ work: [], after: [] }];
  for (const it of pre) {
    const block = blocks[blocks.length - 1];
    // What it said just before a picture introduces it, so it stays in view too.
    if (pinned(it) && !block.after.length) while (block.work.length && block.work[block.work.length - 1].kind === 'text') block.after.unshift(block.work.pop()!);
    if (pinned(it)) block.after.push(it);
    else if (block.after.length) blocks.push({ work: [it], after: [] });
    else block.work.push(it);
  }
  // A chat read from another CLI's history has no streaming steps and no end.
  const live = !d && (list.some((it) => it.status === 'streaming') || (tail && !!working));
  const outLoud = (items: Item[]) => {
    const nodes: ReactNode[] = [];
    for (let i = 0; i < items.length;) {
      if (isApart(items[i])) { nodes.push(<ItemView key={items[i].id} item={items[i]} byParent={byParent} commandOutput={commandOutput} />); i += 1; continue; }
      let j = i;
      while (j < items.length && !isApart(items[j])) j += 1;
      const group = items.slice(i, j);
      nodes.push(<div key={`final-${group[0].id}`} className="final">{group.map((it) => <ItemView key={it.id} item={it} byParent={byParent} commandOutput={commandOutput} />)}</div>);
      i = j;
    }
    return nodes;
  };
  const answerNodes = outLoud(answer);
  const answerText = answer.filter((it) => it.kind === 'text' && it.text).map((it) => it.text.trim()).join('\n\n');
  const files = tail && d ? changedFiles(list) : [];
  const lastBlock = blocks.length - 1;
  const workLabel = (i: number) => {
    const split = lastBlock > 0;
    const took = (!split && d?.durationMs) || workSpan(turn, blocks[i].work, tail && i === 0);
    return d?.status === 'interrupted' && i === lastBlock
      ? (took ? `You stopped after ${seconds(took)}` : 'You stopped')
      : (took ? `Worked for ${seconds(took)}` : 'Worked');
  };
  return (
    <>
      {head && display.printed && !!said.text && <div className="turn assistant command-note"><Markdown text={said.text} className="prose" /></div>}
      {/* Another agent talking, the way Claude Code shows a teammate: its
          name and first line, the rest a tap away. Never the owner's bubble. */}
      {head && helper && (
        <details className="turn helper-msg">
          <summary>
            <span className="helper-name">{helper.from}</span>
            {helper.status && helper.status !== 'done' && <span className="helper-status">{helper.status}</span>}
            <span className="helper-line">{helper.text.trim().split('\n')[0]}</span>
            <span className="helper-time">{clock(turn.at)}</span>
          </summary>
          <Markdown text={helper.text} className="prose" />
        </details>
      )}
      {head && !helper && !display.printed && !!(turn.text || turn.attachments?.length) && (
        <div className={`turn user${queued ? ' queued' : ''}`}><div className="bubble">
          {display.to && <span className="turn-note">To {display.to}</span>}
          {said.note && (said.note.length > 160
            // The delegation brief is a paragraph of instructions to the
            // agent; on a phone it buried the one line the owner typed.
            ? <details className="turn-note"><summary>helm note to the agent</summary>{said.note}</details>
            : <span className="turn-note">{said.note}</span>)}
          {/* Pictures sit in their own row above the words, never in the
              line of text, where they pushed it around. */}
          {!!display.attachments?.length && <div className="turn-images">{display.attachments.map((a, i) => (a.data
            // A blob the log has swept past still has its name, and saying
            // so beats a browser's broken-image glyph.
            ? <img key={i} className="turn-image" src={`data:${a.mime};base64,${a.data}`} alt={a.filename} title={`Image #${i + 1}${a.filename ? ` · ${a.filename}` : ''}`} loading="lazy" decoding="async" />
            : <span key={i} className="turn-image-gone" title={a.filename}><Icon name="image" size={14} /> {a.filename || 'image'} — no longer stored</span>
          ))}</div>}
          {said.text}
          <span className="bubble-meta">
            {queued && <span className="tag">queued</span>}
            {/* Still on helm's side of the wire: the agent has not seen it,
                so taking it back is possible - and puts the words back in
                the composer, the way a CLI lets you pull a queued line up. */}
            {queued && onWithdraw && (
              <button className="withdraw" onClick={() => onWithdraw(turn)}>withdraw</button>
            )}
            {onBranch && !queued && !turn.id.startsWith('local-') && (
              <button className="branch" onClick={() => onBranch(turn)} title="a new thread from before this message" aria-label="branch from before this message"><Icon name="branch" size={13} />branch</button>
            )}
            {onRewind && turn.checkpoint && !queued && !turn.local && (
              <button className="branch" onClick={() => onRewind(turn)} title="Edit this message and rewind the conversation">Edit from here</button>
            )}
            {clock(turn.at)}
          </span>
        </div></div>
      )}
      <div className={`turn assistant${note ? ' command-note' : ''}`}>
        {blocks.map((block, i) => (
          <Fragment key={i ? `block-${block.work[0].id}` : 'block-0'}>
            {block.work.length > 0 && (
              <Work key={i ? `work-${block.work[0].id}` : `work-${turn.id}`} turn={turn} items={block.work} byParent={byParent}
                live={live && i === lastBlock} label={workLabel(i)} blocked={blocked} />
            )}
            {outLoud(block.after)}
          </Fragment>
        ))}
        {answerNodes}
        {tail && !d && working && work.length === 0 && !turn.items.some((it) => it.status === 'streaming' && (it.kind === 'text' || isCompaction(it))) && (
          <WorkingLine turn={turn} blocked={blocked} />
        )}
        {tail && d && <ChangedFiles files={files} />}
        {tail && d && (d.status === 'interrupted' ? (work.length ? null : <div className="turn-meta">stopped</div>)
          : d.status === 'error' ? (
            // The error line says why; this only marks the turn, unless
            // nothing else says anything. A bare error turn needs neither.
            !turn.text && turn.items.some((it) => it.kind === 'error') ? null : <div className="turn-meta bad">
              {saidBelow || turn.items.some((it) => it.kind === 'error') || !d.error ? 'Failed' : plainError(d.error)}
              {failed && onResend && (
                // A message that never reached the agent deserves a way to
                // try again that does not start with retyping it.
                <button className="resend" onClick={() => onResend(turn)}>Send again</button>
              )}
            </div>
          )
          : <FinalMeta text={answerText} cost={d.costUsd} tests={testResult(list)} />)}
      </div>
    </>
  );
});

export function Transcript({ turns, status, loaded, empty, earlier, loadingEarlier, onEarlier, onResend, onWithdraw, onBranch, onRewind, pending = [], onReviewRequest, focusItem, readVisual, openAgent }: {
  turns: Turn[]; status: string; loaded: boolean; empty?: string;
  pending?: Permission[]; onReviewRequest?: (requestId: string) => void;
  /** The machine holds more of this conversation than is on screen. */
  earlier?: boolean; loadingEarlier?: boolean; onEarlier?: () => void;
  /** Offered on a turn that ended in an error: send its prompt again. */
  onResend?: (turn: Turn) => void;
  /** Offered while a message is still queued: take it back into the draft. */
  onWithdraw?: (turn: Turn) => void;
  /** Offered on every message but the first: branch the conversation from before it. */
  onBranch?: (turn: Turn) => void;
  onRewind?: (turn: Turn) => void;
  focusItem?: { id: string; visit: number };
  readVisual?: VisualReader;
  /** The chat of the helper a spawn step started, if Helm knows it. */
  openAgent?: (item: Item) => (() => void) | null;
}) {
  const requestKey = pending.map(request => request.requestId).join('\0');
  // Text deltas clone the pending array too. Only changed requests should
  // invalidate every activity group in a long transcript.
  // A file chip in a reply's wrap-up opens its step the way a review link
  // does: same path as focusItem, so folded groups open and it scrolls there.
  const [revealed, setRevealed] = useState<ItemFocus>();
  const reveal = useCallback((id: string) => setRevealed((r) => ({ id, visit: (r?.visit ?? 0) + 1 })), []);
  useEffect(() => setRevealed(undefined), [focusItem]);
  const shownItem = revealed ?? focusItem;
  const requests = useMemo(() => ({ pending, review: onReviewRequest, focusItem: shownItem }), [requestKey, onReviewRequest, shownItem]);
  const box = useRef<HTMLDivElement>(null);
  useCopySelection(box);
  const stuck = useRef(true);
  // Away from the bottom: the "Latest" pill shows. `unread` only says there is something new down there.
  const [away, setAway] = useState(false);
  const [unread, setUnread] = useState(false);
  // A manual history read should show what it fetched, including steps
  // inside the current turn's fold. Its turn.start may already be present
  // as a sparse anchor, so comparing only the first turn misses this case.
  const historyRead = useRef<{ turns: Set<string>; items: Map<string, { text: string; command?: string; input?: Item['input'] }> } | undefined>(undefined);
  const readEarlier = () => {
    if (loadingEarlier || !onEarlier) return;
    historyRead.current = {
      turns: new Set(turns.map(turn => turn.id)),
      items: new Map(turns.flatMap(turn => turn.items.map(item => [item.id, { text: item.text, command: item.command, input: item.input }] as const))),
    };
    stuck.current = false;
    onEarlier();
  };
  // Parent renders supply fresh closures. Keep the memoized turns' handlers
  // stable while dispatching to the latest actions, including during a send.
  const actions = useRef({ onResend, onWithdraw, onBranch, onRewind });
  actions.current = { onResend, onWithdraw, onBranch, onRewind };
  const resend = useCallback((turn: Turn) => actions.current.onResend?.(turn), []);
  const withdraw = useCallback((turn: Turn) => actions.current.onWithdraw?.(turn), []);
  const branch = useCallback((turn: Turn) => actions.current.onBranch?.(turn), []);
  const rewind = useCallback((turn: Turn) => actions.current.onRewind?.(turn), []);
  // The working pulse hangs off the turn still being written - with a helm
  // answer hosted mid-turn, that is not necessarily the last turn in the list.
  // A message the CLI took mid-turn sits inside its host turn and never
  // closes on its own; the host is the one still working.
  const openTurn = turns.filter((t) => !t.done && !t.steered).at(-1);
  const working = status === 'working' || status === 'blocked';

  const onScroll = () => {
    const el = box.current;
    if (!el) return;
    stuck.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    setAway(!stuck.current);
    if (stuck.current) setUnread(false);
  };
  // Only changed transcript content needs a synchronous layout read. Older
  // turns arriving above keep the reader where they were - iOS Safari has no
  // scroll anchoring to do it for us.
  const seen = useRef<{ h: number; first?: string }>({ h: 0 });
  const revision = turns.map((turn) => turn.revision ?? 0).join(',');
  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    const h = el.scrollHeight;
    const first = turns[0]?.id;
    const prev = seen.current;
    seen.current = { h, first };
    const read = historyRead.current;
    if (read && !loadingEarlier) {
      historyRead.current = undefined;
      if (turns.findIndex(turn => read.turns.has(turn.id)) > 0) {
        el.scrollTop = 0;
        onScroll();
        return;
      }
      const items = turns.flatMap(turn => turn.items);
      const item = items.find(item => !read.items.has(item.id)) ?? items.find(item => {
        const previous = read.items.get(item.id);
        return previous && (item.text !== previous.text || item.command !== previous.command || (!previous.input && !!item.input));
      });
      if (item) {
        setRevealed(previous => ({ id: item.id, visit: (previous?.visit ?? 0) + 1, start: true }));
        return;
      }
    }
    if (stuck.current) el.scrollTop = h;
    else if (prev.first !== undefined && first !== prev.first) el.scrollTop += h - prev.h;
    else if (h > prev.h) setUnread(true);
  }, [turns, revision, status, loaded, earlier, loadingEarlier]);

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
    if (el) {
      el.scrollTop = el.scrollHeight;
      stuck.current = true; setUnread(false); setAway(false);
    }
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
  // A failure can arrive as two turns: the message's, ended with the
  // error, then a bare one holding only the error line. The line says why,
  // so the message's turn just says it failed.
  const saidBelow = new Set<string>();
  turns.forEach((t, i) => {
    const next = turns[i + 1];
    if (next && !next.text && next.items.some((it) => it.kind === 'error')) saidBelow.add(t.id);
  });
  const view = (t: Turn, items?: Item[], head = true, tail = true, key: string = t.id) => (
    <TurnView key={key} turn={t} revision={t.revision} items={items} head={head} tail={tail} saidBelow={saidBelow.has(t.id)}
      working={working && t === openTurn} blocked={status === 'blocked'}
      onResend={onResend ? resend : undefined} onWithdraw={onWithdraw ? withdraw : undefined}
      onBranch={onBranch && t !== turns[0] ? branch : undefined} onRewind={onRewind ? rewind : undefined} />
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
    <Busy.Provider value={working || status === 'starting'}>
    <OpenAgent.Provider value={openAgent}>
    <Requests.Provider value={requests}>
    <Reveal.Provider value={reveal}>
    <Visuals.Provider value={readVisual}>
    <div className="chat-wrap">
      <div className="chat" ref={box} onScroll={onScroll}>
        <div className="timeline" onClick={(e) => {
          const img = (e.target as HTMLElement).closest?.('img.turn-image') as HTMLImageElement | null;
          if (img) setZoom({ src: img.src, alt: img.alt });
        }}>
          {/* A chat opens on its last screenful, because that is what you came
              for; the rest of it is a tap away rather than a wait. */}
          {loaded && earlier && (
            <button className="earlier" onClick={readEarlier} disabled={loadingEarlier}>
              {loadingEarlier ? 'reading…' : 'Earlier in this conversation'}
            </button>
          )}
          {!loaded && <p className="placeholder">Loading the conversation…</p>}
          {loaded && turns.length === 0 && <p className="placeholder">{empty ?? 'Send a message to start the conversation.'}</p>}
          {flow}
        </div>
      </div>
      {away && <button type="button" className={`jump${unread ? ' fresh' : ''}`} onClick={jump} aria-label="Scroll to the latest message"><Icon name="arrow-down" size={14} />Latest</button>}
      {prompts >= 3 && (
        <div className="turnnav" role="group" aria-label="jump between your messages">
          <button onClick={() => step(-1)} aria-label="previous message of yours" title="previous message"><Icon name="up" size={16} /></button>
          <button onClick={() => step(1)} aria-label="next message of yours" title="next message"><Icon name="down" size={16} /></button>
        </div>
      )}
      {zoom && <Lightbox src={zoom.src} alt={zoom.alt} onClose={() => setZoom(null)} />}
    </div>
    </Visuals.Provider>
    </Reveal.Provider>
    </Requests.Provider>
    </OpenAgent.Provider>
    </Busy.Provider>
  );
}
