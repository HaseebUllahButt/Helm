import { EventEmitter } from 'node:events';
import { Herdr } from '../herdr.js';

/**
 * The herdr protocol generation helm was written against. herdr reports this
 * from `ping`; if it ever moves we want a loud, specific failure at startup
 * rather than subtly wrong behaviour halfway through a session.
 */
export const EXPECTED_PROTOCOL = 22;
export const PINNED_VERSION = '0.9.0';

export class HerdrRuntime extends EventEmitter {
  capabilities = { agentState: true, rawStream: false, persistent: true };

  constructor({ herdr } = {}) {
    super();
    this.herdr = herdr ?? new Herdr();
    this.herdr.on('event', (e) => this.#translate(e));
  }

  /**
   * Normalise herdr's envelope into the runtime-neutral events helm listens
   * for. Subscriptions are requested with dotted names (`pane.closed`) but
   * herdr DELIVERS them with underscores (`pane_closed`) - checking the
   * dotted form here silently drops every event, which for
   * `pane_agent_status_changed` means a blocked agent never reaches a phone.
   */
  #translate({ event, data }) {
    if (!data) return;
    if (event === 'pane_agent_status_changed') {
      this.emit('status', {
        paneId: data.pane_id,
        status: data.agent_status,
        agent: data.agent,
      });
      return;
    }
    // The safety net for panes helm did not start: `pane_updated` carries the
    // whole PaneInfo, agent_status included, and needs no per-pane watch.
    if (event === 'pane_updated' && data.pane?.pane_id && data.pane.agent_status) {
      this.emit('status', {
        paneId: data.pane.pane_id,
        status: data.pane.agent_status,
        agent: data.pane.agent,
      });
      return;
    }
    if (event === 'pane_closed' || event === 'pane_exited') {
      this.emit('closed', { paneId: data.pane?.pane_id ?? data.pane_id });
      return;
    }
    // Closing a workspace does not deliver pane_closed for its panes.
    if (event === 'workspace_closed') {
      this.emit('closed', { workspaceId: data.workspace_id });
    }
  }

  async ensureReady() {
    await this.herdr.ensureServer();
    const pong = await this.herdr.ping();

    if (pong.protocol !== EXPECTED_PROTOCOL) {
      throw new Error(
        `herdr speaks protocol ${pong.protocol}, helm expects ${EXPECTED_PROTOCOL}. ` +
        `Install herdr ${PINNED_VERSION}, or update helm's adapter.`
      );
    }
    this.version = pong.version;
    this.herdr.startEvents();
    return { version: pong.version, protocol: pong.protocol };
  }

  // ------------------------------------------------------------------ verbs

  async createSession({ cwd, env, label }) {
    const ws = await this.herdr.call('workspace.create', {
      cwd, env, label, focus: false,
    });
    return {
      paneId: ws.root_pane.pane_id,
      workspaceId: ws.workspace.workspace_id,
      tabId: ws.root_pane.tab_id,
    };
  }

  /**
   * Put an agent in a pane.
   *
   * herdr will only start one in a pane that is sitting at its shell prompt,
   * and a freshly created pane is still running shell startup for a moment -
   * long enough to lose the race on a machine with a slow profile. Retry
   * rather than fail a session the user just asked for.
   */
  async startAgent(handle, { kind, args = [], name }) {
    const deadline = Date.now() + 20_000;
    let lastError;
    while (Date.now() < deadline) {
      try {
        await this.herdr.call(
          'agent.start',
          { name, kind, pane_id: handle.paneId, args },
          { timeout: 45_000 }
        );
        return { agentName: name };
      } catch (err) {
        lastError = err;
        if (!/not an available shell|not ready/i.test(err.message)) throw err;
        await new Promise((r) => setTimeout(r, 750));
      }
    }
    throw lastError ?? new Error('pane never became ready for an agent');
  }

  async read(handle, { lines = 200, source = 'recent', ansi = false } = {}) {
    const res = await this.herdr.call('pane.read', {
      pane_id: handle.paneId, source, lines,
      strip_ansi: !ansi, format: ansi ? 'ansi' : 'text',
    });
    return { text: res.read?.text ?? res.text ?? '' };
  }

  sendPrompt(handle, text) {
    return this.herdr.call('agent.prompt', { target: handle.agentName, text });
  }

  sendText(handle, text) {
    return this.herdr.call('pane.send_text', { pane_id: handle.paneId, text });
  }

  sendKeys(handle, keys) {
    return this.herdr.call('pane.send_keys', {
      pane_id: handle.paneId, keys: Array.isArray(keys) ? keys : [keys],
    });
  }

  async close(handle) {
    try {
      await this.herdr.call('workspace.close', { workspace_id: handle.workspaceId });
    } catch { /* already gone is the outcome we wanted */ }
    this.herdr.unwatchPane(handle.paneId);
  }

  /** What the runtime believes is still alive, keyed by pane id. */
  async listLive() {
    const live = new Map();
    try {
      const res = await this.herdr.call('pane.list', {});
      for (const p of res.panes ?? []) {
        live.set(p.pane_id, {
          status: p.agent_status,
          cwd: p.cwd,
          title: p.terminal_title_stripped ?? p.terminal_title,
          workspaceId: p.workspace_id,
          tabId: p.tab_id,
        });
      }
      // Which panes actually hold a recognised agent, and what kind.
      const agents = await this.herdr.call('agent.list', {});
      for (const a of agents.agents ?? []) {
        const entry = live.get(a.pane_id);
        if (entry) {
          entry.agentName = a.name;
          entry.engine = a.kind ?? a.agent;
          entry.status = a.status ?? entry.status;
        }
      }
    } catch { /* runtime down: caller falls back to last known state */ }
    return live;
  }

  watch(handle) { this.herdr.watchPane(handle.paneId); }
  unwatch(handle) { this.herdr.unwatchPane(handle.paneId); }
  stop() { this.herdr.close(); }

  /**
   * Agent kinds this runtime can recognise, with the version of the detection
   * rules behind each. helm surfaces these so a stale manifest is visible
   * rather than showing up as an agent whose state never updates.
   */
  async kinds() {
    try {
      const res = await this.herdr.call('server.agent_manifests', {});
      return (res.manifests ?? []).map((m) => ({
        kind: m.agent,
        detectionVersion: m.active_version,
        updateState: m.remote_update_result,
      })).filter((m) => m.kind);
    } catch {
      return [];
    }
  }
}
