import { AcpDriver } from './acp.js';
import { cliVersion } from './index.js';
import { modeFor } from '../modes.js';

/**
 * opencode, headless: `opencode acp` speaks ACP over stdio.
 *
 * Its session "mode" is the agent choice - `build` asks, `plan` plans - so
 * helm's wider permission modes are enforced driver-side: 'edit' and 'auto'
 * answer matching `session/request_permission` requests without ever
 * bothering the phone (see modes.js `autoAllow`). Model and thinking level
 * ride `session/set_config_option` ('model' and 'effort'); the model picker
 * it returns doubles as the session's catalogue.
 *
 * Written against opencode 1.18.26, probed live: session/new returns
 * configOptions for model, effort and mode; session/load resumes by id.
 */
export const OPENCODE_MIN_VERSION = '1.18.0';

/**
 * OpenCode's free models each have their own limit. On 2026-11-11 a lead on
 * why started a dozen helpers on free models; the DeepSeek and GLM ones
 * failed with "Free usage limit reached" while the MiniMax one kept working.
 * A chat on a free model that hits its limit moves to another free model
 * and goes on. A paid model never moves: that would change its quality.
 */
const spentFree = new Map();
const SPENT_MS = 60 * 60 * 1000;
const isFree = (model) => /-free$/.test(String(model ?? ''));

export async function nextFreeModel(d, error, now = Date.now()) {
  if (!/free usage limit/i.test(String(error?.message ?? ''))) return null;
  const catalog = d.catalog();
  const current = catalog?.current ?? d.model;
  if (!isFree(current)) return null;
  spentFree.set(current, now);
  const fresh = (m) => !(now - (spentFree.get(m) ?? -Infinity) < SPENT_MS);
  for (const next of catalog?.models ?? []) {
    if (next === current || !isFree(next) || !fresh(next)) continue;
    const r = await d.setModel(next);
    if (r?.applied === false) { spentFree.set(next, now); continue; }
    const name = (m) => catalog.labels?.[m] || m;
    d.push('settings', { model: next });
    d.push('error', { message: `${name(current)} reached its free limit. Helm moved this chat to ${name(next)}, and it goes on.`, kind: 'retrying' });
    return [{ type: 'text', text: 'The last model reached its free usage limit and stopped. Continue the task from the point where it stopped.' }];
  }
  return null;
}
/** For tests: forget which free models ran out. */
export function forgetSpentFree() { spentFree.clear(); }

export class OpencodeDriver extends AcpDriver {
  constructor(opts) {
    super({
      engine: 'opencode',
      label: 'opencode',
      min: OPENCODE_MIN_VERSION,
      // No --cwd: the process starts in the chat's folder and session/new
      // names it too. OpenCode 2.x installed as `opencode` refuses the flag,
      // and every OpenCode helper died at start on 2026-11-11.
      args: () => ['acp'],
      acpMode: (m) => modeFor('opencode', m)?.acp ?? null,
      effortId: 'effort',
      // A prompt sent while a run is going is added to that session and
      // read by the running loop at its next step, the way the TUI queues
      // typing; both prompts answer when the loop ends.
      promptWhileBusy: true,
      prepare: (d) => d.matchVersion(),
      retry: nextFreeModel,
    }, opts);
  }

  /**
   * `opencode` can be OpenCode 2: on the Laptop and why the v2 install took
   * over the name (2026-11-11), while the VM still runs 1.19. A v2 program
   * gets the OpenCode 2 rules: resume without a replay, and a message typed
   * mid-turn waits for the reply (Opencode2Driver).
   */
  async matchVersion() {
    const have = await cliVersion(this.cmd, this.env).catch(() => null);
    this.v2 = !!have && Number(have.split('.')[0]) >= 2;
    if (!this.v2) return;
    this.spec.resumeVerb = 'session/resume';
    this.spec.promptWhileBusy = false;
    // Delivery steers only when the driver has a steer method.
    this.steer = undefined;
  }

  /** A waiting message joins the running loop at its next step. */
  async steer(text, attachments = [], options = {}) { return this.sendDuringTurn(text, attachments, options); }
}

/**
 * OpenCode 2 preview, which ships as a separate `opencode2` executable. Its
 * ACP side has not been seen to fold a second prompt into a running loop,
 * so messages typed mid-turn wait for the reply there.
 */
export class Opencode2Driver extends AcpDriver {
  constructor(opts) {
    super({
      engine: 'opencode2',
      label: 'OpenCode 2',
      // Preview versions are 0.0.0-beta-N; the live ACP handshake is the
      // compatibility check that matters while that channel is unversioned.
      min: '0.0.0',
      args: () => ['acp'],
      acpMode: (m) => modeFor('opencode2', m)?.acp ?? null,
      effortId: 'effort',
      // session/load replays every past message only for Helm to drop them;
      // resume picks the conversation up without the replay. Builds without
      // it fall back to session/load.
      resumeVerb: 'session/resume',
      retry: nextFreeModel,
    }, opts);
  }
}
