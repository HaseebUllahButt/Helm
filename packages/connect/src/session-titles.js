import { GREETING, PLACEHOLDER, informative, promptTitle } from './titles.js';
import { wire } from './session-wire.js';
import { clip } from './session-text.js';

/**
 * A name for a session that is more than the folder it runs in.
 *
 * Two sources: the agent itself - ACP sessions report the title they chose
 * as `session_info_update`, kept on the record as `generatedTitle` - and the
 * prompts, which always exist. Either kind lands only once the session has
 * TITLE_AFTER conversation messages behind it: named on the first alone, a real
 * fraction of sessions would be called "hi". The name the owner typed at
 * start (`titleBy: 'user'`) always wins.
 */
const TITLE_AFTER = 2;
const TITLE_RANK = { auto: 1, agent: 2, user: 3 };

/** A session's name: from its prompts, from the agent, or typed by the owner. */
export class SessionTitles {
  #sessions;
  #core;
  constructor(sessions, core) {
    this.#sessions = sessions;
    this.#core = core;
  }

  /**
   * One more real prompt behind the session. The title gate opens at
   * TITLE_AFTER: take the agent's own name when it reported a meaningful
   * one, else make one out of the prompts themselves.
   */
  prompted(s, text) {
    if (!this.#core.index.has(s.id)) return;
    s.prompts = (s.prompts ?? 0) + 1;
    // Only a prompt that says something about the work is worth sampling: a
    // session that opens "hi", "hello" would otherwise fill the sample with
    // greetings and never earn a name at all.
    const sample = (s.promptSample ??= []);
    const request = informative(text);
    if (sample.length < TITLE_AFTER && request) sample.push(request.slice(0, 200));
    this.#core.save();
    // The gate opens *at* TITLE_AFTER and stays open: when the first prompts
    // were all greetings there is nothing to name the session after yet, and
    // the one that finally says something still deserves to name it.
    if ((s.prompts ?? 0) + (s.turns ?? 0) < TITLE_AFTER) return;
    const agent = s.generatedTitle || null;
    const pick = agent ?? promptTitle(s.promptSample);
    if (pick) this.titled(s, pick, agent ? 'agent' : 'auto');
  }

  /**
   * Adopt a candidate title once the session is old enough for it to be
   * trusted. The agent's own name outranks one derived from the prompts; a
   * name the owner typed outranks both.
   */
  titled(s, title, by) {
    const clean = String(title ?? '').replace(/\s+/g, ' ').trim();
    if (!clean) return;
    if (by !== 'user' && PLACEHOLDER.test(clean)) return;
    if (by === 'agent') {
      // An ACP agent's first name for a session is a copy of the prompt, and
      // it keeps reporting one - so "hi" three prompts in would otherwise
      // rename a session that had already earned something better.
      if (GREETING.test(clean)) return;
      if (s.generatedTitle !== clean) {
        s.generatedTitle = clean;
        this.#core.save();
      }
    }
    // The gate is about *generated* names being premature. A name the owner
    // typed is never premature.
    if (by !== 'user' && (s.prompts ?? 0) + (s.turns ?? 0) < TITLE_AFTER) return;
    if ((TITLE_RANK[by] ?? 0) < (TITLE_RANK[s.titleBy] ?? 0)) return;
    const named = clip(clean, 80);
    if (s.title === named && s.titleBy === by) return;
    s.title = named;
    s.titleBy = by;
    this.#core.save();
    this.#sessions.emit('session', s);
  }

  /**
   * The name the owner typed, which outranks anything helm or the agent
   * came up with and is never overwritten afterwards.
   */
  rename(id, title) {
    this.#core.rewinder.assertRewindUnlocked(id);
    const s = this.#sessions.get(id);
    if (s.adopted) throw new Error('an external session is named by the program that started it');
    const clean = String(title ?? '').replace(/\s+/g, ' ').trim();
    if (!clean) throw new Error('a thread needs a name');
    this.titled(s, clean, 'user');
    return { ok: true, session: wire(s) };
  }
}
