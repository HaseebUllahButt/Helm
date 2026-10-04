import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { M } from '@helm/protocol';
import { beginTransferActivity } from '@helm/protocol/transfer-activity';
import { HELM_DIR } from './paths.js';
import { createCodeSnapshot, sealCodeSnapshot, signHandoffDigest } from './code-transfer.js';
import { handoffRequestDigest } from './handoffs.js';
import { transferPreflight } from './transfer-check.js';
import { readThread } from './brain.js';
import { delegationMode } from './delegation.js';

const ID = /^[a-f0-9]{24}$/;
const networkFailure = (error) => /offline|not connected|reach|ECONN|socket|timed out|timeout|closed/i.test(error.message);
const line = (value, max) => typeof value === 'string' && value.length > 0
  && value.length <= max && !/[\u0000-\u001f\u007f]/.test(value);

export class TaskTransfers {
  constructor({ network, sessions, rpc, enqueue, directory = join(HELM_DIR, 'outgoing-tasks') }) {
    Object.assign(this, { network, sessions, rpc, enqueue, directory });
    this.inflight = new Map();
  }

  async send(params, caller) {
    const net = this.network();
    if (!caller || net.revoked?.[caller] || !(caller === net.self || net.devices?.[caller])) {
      throw new Error('sending a task is for this machine or a paired device only');
    }
    if (!ID.test(params?.handoffId ?? '')) throw new Error('invalid handoff id');
    const target = net.machines?.[params.targetMachineId];
    if (!target || target.id === net.self || net.revoked?.[params.targetMachineId]) {
      throw new Error('send a task to another current machine in this network');
    }
    const intent = {
      targetMachineId: params.targetMachineId, folder: params.folder,
      targetFolder: params.targetFolder || null, sessionId: params.sessionId || null,
      profileId: params.profileId, model: params.model || null, mode: params.mode || null,
      prompt: params.prompt || '', includeEnv: params.includeEnv === true,
    };
    if (!line(intent.folder, 1024)) throw new Error('a task needs a source folder');
    if (!line(intent.profileId, 256)) throw new Error('choose an agent account on the target');
    if (intent.targetFolder !== null && !line(intent.targetFolder, 1024)) throw new Error('invalid destination folder');
    for (const name of ['sessionId', 'model', 'mode']) {
      if (intent[name] !== null && !line(intent[name], 256)) throw new Error(`invalid task ${name}`);
    }
    if (typeof intent.prompt !== 'string' || intent.prompt.length > 32_000 || (!intent.prompt.trim() && !intent.sessionId)) throw new Error('a new task needs a prompt of at most 32000 characters');
    const fingerprint = createHash('sha256').update(JSON.stringify(intent)).digest('hex');
    const running = this.inflight.get(params.handoffId);
    if (running) {
      if (running.fingerprint !== fingerprint) throw new Error('task retry does not match its original request');
      return running.work;
    }
    const endActivity = beginTransferActivity();
    const work = this.#send(net, target, params, intent, fingerprint)
      .finally(() => { endActivity(); this.inflight.delete(params.handoffId); });
    this.inflight.set(params.handoffId, { fingerprint, work });
    return work;
  }

  #save(id, record) {
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    const file = join(this.directory, `${id}.json`);
    const temp = `${file}.tmp`;
    writeFileSync(temp, JSON.stringify(record), { mode: 0o600 });
    renameSync(temp, file);
  }

  async #send(net, target, params, intent, fingerprint) {
    const file = join(this.directory, `${params.handoffId}.json`);
    let record = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : null;
    if (record && record.fingerprint !== fingerprint) throw new Error('task retry does not match its original request');
    if (record?.result?.status === 'running') return record.result;
    if (!record) {
      if (!target.codePubkey) throw new Error('the target needs a code-transfer key; restart Helm there');
      const { agents } = await this.rpc(target.id, M.AGENT_LIST, { models: false });
      const account = agents.find((agent) => agent.id === intent.profileId && agent.available);
      if (!account) throw new Error('the selected agent account is unavailable on the target');
      let source = intent.sessionId ? this.sessions.get(intent.sessionId) : null;
      if (source && (source.cwd !== intent.folder || source.external || source.engine === 'shell')) {
        throw new Error('only a managed agent task in this project can be continued');
      }
      const mode = delegationMode(account.engine, source?.mode, intent.mode,
        account.defaultMode, source?.engine ?? account.engine);
      let snapshot = createCodeSnapshot(intent.folder, { includeEnv: intent.includeEnv });
      let preflight = transferPreflight(snapshot);
      if (preflight.requiresAcknowledgement && params.allowSkipped !== true) {
        return { sent: false, requiresAcknowledgement: true, preflight };
      }
      const history = source ? await this.sessions.history(source.id, { tail: 500, limit: 500 }) : null;
      if (source) {
        await this.sessions.interrupt(source.id);
        const deadline = Date.now() + 30_000;
        while (['starting', 'working', 'blocked'].includes(this.sessions.get(source.id).status)) {
          if (Date.now() >= deadline) throw new Error('the source task has not stopped yet; wait and retry the handoff');
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
        snapshot = createCodeSnapshot(intent.folder, { includeEnv: intent.includeEnv });
        preflight = transferPreflight(snapshot);
        if (preflight.requiresAcknowledgement && params.allowSkipped !== true) {
          return { sent: false, requiresAcknowledgement: true, preflight };
        }
      }
      const context = history ? readThread(history.events, { limit: 80 }).join('\n').slice(-24_000) : '';
      const folder = intent.targetFolder || `~/.helm/workspaces/${snapshot.rootName}-${params.handoffId.slice(0, 8)}`;
      const request = {
        handoffId: params.handoffId, sourceMachineId: net.self, targetMachineId: target.id,
        folder, snapshotDigest: snapshot.digest,
        envelope: sealCodeSnapshot(snapshot, target.codePubkey, params.handoffId),
        profileId: intent.profileId, model: intent.model || undefined, mode,
        restoreGit: false,
        title: (source?.title || intent.prompt.trim().split('\n')[0]).replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, 120),
        prompt: [
          `Continue this task on ${target.name ?? target.id} in the current working directory.`,
          intent.prompt.trim() || 'Continue the existing task using the conversation context below.',
          `The project files were copied directly from ${net.machines[net.self]?.name ?? net.self}. No GitHub checkout or fetch is needed.`,
          `Project .env files were ${intent.includeEnv ? 'included where present' : 'excluded'}. Use this machine's agent login. Machine-wide environment variables, credentials, running processes, dependencies and virtual environments were not copied.`,
          `Source runtime: ${process.platform}/${process.arch}, Node ${process.version}. Inspect project instructions, runtime version files, manifests and lockfiles; recreate the required dependencies and environment on this machine before continuing. Preserve the selected permission restrictions. Report missing credentials or runtimes instead of inventing them. Never print secret values.`,
          preflight.skipped ? `Omitted files and setup warnings: ${JSON.stringify(preflight.warnings).slice(0, 6000)}` : '',
          context ? `Conversation context (a bounded transcript, not a live process):\n${context}` : '',
        ].filter(Boolean).join('\n\n'),
      };
      if (source) request.parent = {
        handoffId: params.handoffId, machineId: net.self, sessionId: source.id,
        sourceFolder: intent.folder, digest: snapshot.digest,
      };
      request.promptEnvelope = sealCodeSnapshot({ type: 'task-prompt', prompt: request.prompt }, target.codePubkey, params.handoffId);
      request.prompt = 'Continue the encrypted task using its transferred project.';
      request.requestDigest = handoffRequestDigest(request);
      request.sourceSignature = signHandoffDigest(request.requestDigest);
      record = { fingerprint, request, preflight };
      this.#save(params.handoffId, record);
    }
    let receipt;
    let route = 'relay';
    try {
      receipt = await this.rpc(target.id, M.HANDOFF_ACCEPT, record.request, {
        timeout: 240_000, direct: true, onRoute: (value) => { route = value; },
      });
    } catch (error) {
      if (error.rpc || !networkFailure(error)) throw error;
      await this.enqueue(target.id, record.request);
      return { sent: true, status: 'queued', handoffId: params.handoffId,
        targetMachineId: target.id, targetName: target.name, preflight: record.preflight };
    }
    const result = {
      sent: true, status: 'running', handoffId: params.handoffId, route,
      targetMachineId: target.id, targetName: target.name, preflight: record.preflight, receipt,
    };
    if (record.request.parent) {
      try {
        this.sessions.linkChild(record.request.parent.sessionId, {
          handoffId: params.handoffId, machineId: target.id, sessionId: receipt.sessionId,
          folder: receipt.folder, digest: receipt.digest, title: record.request.title,
        });
      } catch (error) { result.warning = `The task is running, but its source link could not be saved: ${error.message}`; }
    }
    record.result = result;
    this.#save(params.handoffId, record);
    return result;
  }
}
