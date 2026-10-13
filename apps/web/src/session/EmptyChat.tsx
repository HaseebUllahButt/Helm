import { useLayoutEffect, useRef } from 'react';

const folderName = (p = '') => p.replace(/\/+$/, '').split('/').pop() || '~';

/**
 * What a chat with nothing said yet looks like: a big question over the
 * composer, which sits in the middle of the page instead of at the bottom.
 * The first message sends the composer down to its usual dock (see
 * useDockLift) and this goes away.
 */
export function EmptyChat({ cwd, quick, brain, machine, agent, model, note }: {
  cwd?: string; quick?: boolean; brain?: boolean;
  machine: string; agent: string; model?: string;
  /** Said under the question instead of the model, such as that the agent is still starting. */
  note?: React.ReactNode;
}) {
  const folder = !quick && !brain && cwd ? folderName(cwd) : '';
  return (
    <div className="empty-chat" data-empty-chat>
      <h2 className="empty-chat-title">
        {folder
          ? <>What should we build in <span className="empty-chat-folder" title={cwd}>{folder}</span>?</>
          : quick ? 'What is on your mind?' : brain ? 'What should we work on?' : 'What should we build?'}
      </h2>
      <p className="empty-chat-sub">{[machine, agent, model].filter(Boolean).join(' · ')}{note}</p>
    </div>
  );
}

/**
 * The composer is centred while the chat is empty. When the first message
 * lands it drops to the bottom; this slides it there instead of jumping, and
 * fades the conversation in. Nothing moves for people who ask for less motion.
 */
export function useDockLift(empty: boolean) {
  const anchor = useRef<HTMLSpanElement>(null);
  const was = useRef<{ empty: boolean; top: number } | null>(null);
  useLayoutEffect(() => {
    const parent = anchor.current?.parentElement;
    const dock = parent?.querySelector<HTMLElement>(':scope > .composer-wrap');
    if (!parent || !dock) return;
    const before = was.current;
    if (before?.empty && !empty && typeof dock.animate === 'function'
      && !window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) {
      const delta = before.top - dock.getBoundingClientRect().top;
      if (Math.abs(delta) > 2) {
        dock.animate([{ transform: `translateY(${delta}px)` }, { transform: 'none' }], { duration: 260, easing: 'cubic-bezier(0.2, 0, 0, 1)' });
        parent.querySelector<HTMLElement>(':scope > .chat-wrap')
          ?.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 240, easing: 'ease-out' });
      }
    }
    was.current = { empty, top: dock.getBoundingClientRect().top };
  });
  return anchor;
}
