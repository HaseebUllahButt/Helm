import { randomBytes, createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdirSync, chmodSync, rmSync, lstatSync } from 'node:fs';
import { createServer } from 'node:net';
import { join, dirname, resolve, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { M } from '@helm/protocol';
import { HELM_DIR, expand } from './paths.js';
import { scanSend } from './send-plan.js';
import { records, saveRecord } from './send-journal.js';
import { copyProxy, CopyConnections } from './copy-proxy.js';
import { sendReceiptDigest } from './send-receiver.js';
import { verifyHandoffSignature } from './code-transfer.js';
import { runCopy, rsyncPath } from './copy.js';
import { beginTransferActivity } from '@helm/protocol/transfer-activity';
const ACTIVE = new Set(['preparing', 'sending', 'finishing']);
const ID = /^[a-f0-9]{24}$/;
const quote = s => `'${String(s).replace(/'/g, "''")}'`;

function abortable(work, signal) {
  return new Promise((resolve, reject) => {
    const abort = () => reject(new Error('send cancelled'));
    signal.addEventListener('abort', abort, { once: true });
    work.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
    // The work has already started. Even an immediate cancel must observe
    // its eventual rejection, or a failed scan can stop the daemon.
    if (signal.aborted) abort();
  });
}

export class SendEngine {
  constructor({ network, rpc, emit = () => {}, directory = join(HELM_DIR, 'send-jobs'), copy = runCopy, spawnProcess = spawn, proxyDeps = {}, timing = () => {}, reuseConnections = true, presence = () => null }) {
    Object.assign(this, { network, rpc, emit, directory, copy, spawnProcess, proxyDeps, timing, reuseConnections, presence });
    this.bridgeSockets = new Set();
    this.jobs = new Map(); this.running = new Map(); this.capabilities = new Map(); this.connections = new CopyConnections();
    this.socket = join(directory, `tunnel-${process.pid}-${randomBytes(3).toString('hex')}.sock`);
    for (const r of records(directory)) {
      if (ACTIVE.has(r.job.phase)) { r.job.phase = 'interrupted'; r.job.rate = null; r.job.eta = null; r.job.error = 'The source daemon stopped. Retry to resume.'; r.job.updatedAt = Date.now(); saveRecord(this.file(r.job.id), r); }
      this.jobs.set(r.job.id, r);
    }
  }
  file(id) { return join(this.directory, `${id}.json`); }
  net() { return typeof this.network === 'function' ? this.network() : this.network; }
  authorize(caller) { const n = this.net(); if (!caller || n.revoked?.[caller] || !(caller === n.self || n.devices?.[caller])) throw new Error('sending is for this machine or a paired device only'); }
  get(id) { if (!ID.test(id ?? '') || !this.jobs.has(id)) throw new Error('send job not found'); return this.jobs.get(id); }
  update(r, force = false) {
    r.job.updatedAt = Date.now();
    const now = Date.now();
    if (force || !r.lastSave || now - r.lastSave >= 250) {
      r.lastSave = now;
      saveRecord(this.file(r.job.id), { job: r.job, options: r.options, intent: r.intent, receipt: r.receipt, attempted: r.attempted });
    }
    // A copy that is one step of a bigger action (a chat move) shows as that action, not as a Send.
    if (r.job.internal) return;
    const publish = () => {
      r.emitTimer = null; r.lastEmit = Date.now();
      try { this.emit({ job: structuredClone(r.job) }); } catch { /* a disconnected app cannot stop a send */ }
    };
    if (!r.lastEmit || now - r.lastEmit >= 250) {
      clearTimeout(r.emitTimer); publish();
    } else if (!r.emitTimer) {
      r.emitTimer = setTimeout(publish, 250 - (now - r.lastEmit)); r.emitTimer.unref?.();
    }
  }

  prior(path, target) { return [...this.jobs.values()].filter(r => r.job.source.path === path && r.job.target.machineId === target && r.job.phase === 'done').sort((a,b) => b.job.updatedAt - a.job.updatedAt)[0]; }
  async plan(params, caller) {
    this.authorize(caller); const p = await scanSend(params.path); const net = this.net();
    const state = this.presence();
    const targets = Object.values(net.machines).filter(m => m.id !== net.self && !net.revoked?.[m.id]).map(m => {
      const old = this.prior(p.path, m.id);
      return { machineId: m.id, name: m.name, online: state?.[m.id]?.online ?? m.online !== false, destination: old?.job.target.path ?? `~/${p.name}`, sentBefore: old ? { at: old.job.finishedAt, jobId: old.job.id } : null };
    });
    const last = [...this.jobs.values()].filter(r => r.job.source.path === p.path).sort((a,b) => b.job.createdAt - a.job.createdAt)[0];
    return { path: p.path, name: p.name, kind: p.kind, git: p.git, files: p.files, bytes: p.bytes, envFiles: p.envFiles, left: p.left, targets, defaultTarget: params.targetMachineId ?? (targets.some(t => t.machineId === last?.job.target.machineId) ? last.job.target.machineId : null) ?? targets.find(t => t.name === 'VM')?.machineId ?? targets.find(t => t.online)?.machineId ?? null };
  }
  start(params, caller) {
    this.authorize(caller); const net = this.net(), peer = net.machines?.[params.targetMachineId];
    if (!peer || peer.id === net.self || net.revoked?.[peer.id]) throw new Error('choose another current machine');
    if (typeof params.path !== 'string' || !params.path) throw new Error('send needs a source path');
    const path = resolve(expand(params.path)), old = this.prior(path, peer.id);
    const destination = params.destination ?? old?.job.target.path ?? `~/${basename(path)}`;
    let kind = 'folder'; try { if (lstatSync(path).isFile()) kind = 'file'; } catch {}
    const id = randomBytes(12).toString('hex'), now = Date.now();
    const r = { options: { ...params, includeEnv: params.includeEnv !== false }, job: {
      id, createdAt: now, updatedAt: now, finishedAt: null, source: { machineId: net.self, name: net.machines[net.self]?.name, path, kind },
      target: { machineId: peer.id, name: peer.name, path: destination }, again: !!old && old.job.target.path === destination, ...(params.internal ? { internal: true } : {}), phase: 'preparing', bytes: { total: null, sent: 0 }, files: { total: null, sent: 0 }, rate: null, eta: null, changed: null, route: null, error: null, left: [] } };
    this.jobs.set(id, r); this.update(r, true); this.launch(r);
    return { job: structuredClone(r.job) };
  }
  status({ jobId }, caller) { this.authorize(caller); return { job: structuredClone(this.get(jobId).job) }; }
  list({ limit = 50 } = {}, caller) { this.authorize(caller); if (!Number.isInteger(limit) || limit < 1) throw new Error('invalid job limit'); return { jobs: [...this.jobs.values()].map(r => r.job).filter(j => !j.internal).sort((a,b) => Number(ACTIVE.has(b.phase)) - Number(ACTIVE.has(a.phase)) || b.createdAt - a.createdAt).slice(0, limit).map(j => structuredClone(j)) }; }
  acceptReceipt(r, receipt) {
    const n = this.net();
    const intentDigest = createHash('sha256').update(JSON.stringify({ ...r.intent, source: n.self })).digest('hex');
    if (receipt.jobId !== r.job.id || receipt.sourceMachineId !== n.self || receipt.intentDigest !== intentDigest
      || !verifyHandoffSignature(n.machines[r.job.target.machineId].codeSignPubkey, sendReceiptDigest(receipt), receipt.signature)) throw new Error('receiver commit receipt did not verify');
    r.receipt = receipt; r.job.target.path = receipt.folder; this.update(r, true);
  }
  async cancel({ jobId }, caller) {
    this.authorize(caller); const r = this.get(jobId); if (r.job.phase === 'done') return { job: structuredClone(r.job) };
    const running = this.running.get(jobId);
    if (running) { running.cancelled = true; running.abort.abort(); running.child?.kill('SIGTERM'); await running.work; }
    if (r.attempted && r.intent && !r.receipt) {
      try { const response = await this.rpc(r.job.target.machineId, M.SEND_RECEIPT, { jobId }, { timeout: 3000, budget: 3000 }); if (response.receipt) this.acceptReceipt(r, response.receipt); } catch {}
    }
    if (r.receipt) { r.job.phase = 'done'; r.job.error = null; r.job.finishedAt = r.receipt.at; r.job.bytes.sent = r.job.bytes.total ?? r.job.bytes.sent; r.job.files.sent = r.job.files.total ?? r.job.files.sent; this.update(r, true); }
    if (r.job.phase !== 'done') { r.job.phase = 'cancelled'; r.job.rate = null; r.job.eta = null; r.job.finishedAt = Date.now(); r.job.error = null; this.update(r, true); }
    return { job: structuredClone(r.job) };
  }
  retry({ jobId }, caller) {
    this.authorize(caller); const r = this.get(jobId);
    if (!['failed','cancelled','interrupted'].includes(r.job.phase)) throw new Error('only a stopped send can be retried');
    r.job.phase = 'preparing'; r.job.error = null; r.job.finishedAt = null;
    r.job.rate = null; r.job.eta = null; r.job.route = null; r.job.changed = null; r.tail = '';
    this.update(r, true); this.launch(r); return { job: structuredClone(r.job) };
  }
  launch(r) {
    const run = { abort: new AbortController(), child: null, cancelled: false };
    this.running.set(r.job.id, run);
    run.work = Promise.resolve().then(() => this.perform(r, run)).catch(e => {
      r.job.phase = run.cancelled ? 'cancelled' : this.stopping ? 'interrupted' : 'failed'; this.capabilities.delete(r.job.target.machineId);
      r.job.rate = null; r.job.eta = null;
      r.job.error = run.cancelled ? null : String(e.message).slice(0, 500); r.job.finishedAt = Date.now(); this.update(r, true);
    }).finally(() => this.running.delete(r.job.id));
  }
  async wait(id) { await this.running.get(id)?.work; return structuredClone(this.get(id).job); }
  async ensureServer() {
    if (this.serverReady) return this.serverReady;
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    this.server = createServer(socket => {
      this.bridgeSockets.add(socket); socket.once('close', () => this.bridgeSockets.delete(socket));
      socket.on('error', () => {}); let header = Buffer.alloc(0);
      const read = chunk => {
        header = Buffer.concat([header, chunk]); const end = header.indexOf(10);
        if (end < 0) { if (header.length > 8192) socket.destroy(); return; }
        socket.off('data', read); socket.pause();
        let input;
        try {
          input = JSON.parse(header.subarray(0, end)); const r = this.get(input.jobId), run = this.running.get(input.jobId);
          if (!run || run.bridge) throw new Error('send tunnel not active');
          run.bridge = socket;
          if (header.length > end + 1) socket.unshift(header.subarray(end + 1));
          const target = r.job.target.machineId;
          run.bridgeDone = copyProxy(['--machine', target, '--target-folder', r.stage, '--', ...input.args], {
            ...this.proxyDeps, network: this.net(), input: socket, output: socket, stderr: { write: text => { r.tail = ((r.tail ?? '') + text).slice(-8192); } },
            connections: this.reuseConnections ? this.connections : undefined, timing: this.timing, sendJob: r.intent, signal: run.abort.signal,
            onRoute: route => { r.job.route = route; this.update(r, true); },
            onProof: proof => {
              if (!proof.send) throw new Error('target did not confirm Send v2');
              r.job.target.path = proof.send.destination; this.update(r, true);
            },
            onReceipt: receipt => this.acceptReceipt(r, receipt),
          }).then(code => { run.bridgeCode = code; socket.end(); }, () => socket.destroy());
        } catch { socket.destroy(); }
      };
      socket.on('data', read);
    });
    this.serverReady = new Promise((resolve, reject) => { this.server.once('error', reject); this.server.listen(this.socket, () => { chmodSync(this.socket, 0o600); resolve(); }); });
    return this.serverReady;
  }
  async capability(id) {
    if (this.net().machines?.[id]?.sendV2 === true) return { sendV2: true };
    if (!this.capabilities.has(id)) this.capabilities.set(id, this.rpc(id, M.ENV_INFO, {}, { direct: true }).catch(e => { this.capabilities.delete(id); throw e; }));
    return this.capabilities.get(id);
  }
  async perform(r, run) {
    const endActivity = beginTransferActivity(); this.timing('job-start', { jobId: r.job.id });
    try {
      // Recover an already published job before touching its source again.
      // The source may have changed or gone away since the reply was lost.
      if (r.attempted && r.intent) {
        if (!r.receipt && (await abortable(this.capability(r.job.target.machineId), run.abort.signal)).sendV2 === true) {
          try {
            const result = await abortable(this.rpc(r.job.target.machineId, M.SEND_RECEIPT, { jobId: r.job.id }, { direct: true }), run.abort.signal);
            if (result.receipt) this.acceptReceipt(r, result.receipt);
          } catch (e) { if (!/no send receipt/.test(e.message)) throw e; }
        }
        if (r.receipt) {
          r.job.phase = 'done'; r.job.error = null; r.job.finishedAt = r.receipt.at;
          r.job.bytes.sent = r.job.bytes.total ?? r.job.bytes.sent;
          r.job.files.sent = r.job.files.total ?? r.job.files.sent; r.job.eta = 0;
          this.timing('job-done', { jobId: r.job.id }); this.update(r, true); return;
        }
      }
      // Remote discovery and local enumeration overlap; no preview or hashing round trip.
      const [plan, info] = await abortable(Promise.all([scanSend(r.options.path, { includeEnv: r.options.includeEnv, filterFile: join(this.directory, `${r.job.id}.filter`) }), this.capability(r.job.target.machineId)]), run.abort.signal);
      this.timing('scan-and-capability', { jobId: r.job.id });
      if (run.abort.signal.aborted) throw new Error('send cancelled');
      const old = this.prior(plan.path, r.job.target.machineId);
      Object.assign(r.job.source, { path: plan.path, kind: plan.kind }); r.job.bytes.total = plan.bytes; r.job.files.total = plan.files; r.job.left = plan.left;
      if (plan.kind === 'file' && plan.files === 0) throw new Error('the source environment file was excluded; include it or choose another file');
      if (!r.intent) {
        const destination = r.options.destination ?? old?.job.target.path ?? `~/${plan.name}`;
        r.job.target.path = destination; r.job.again = !!old && old.job.target.path === destination;
        r.intent = { id: r.job.id, destination, kind: plan.kind, name: plan.name, again: r.job.again, defaultDestination: !r.options.destination && !old, ...(r.options.marker ? { marker: r.options.marker } : {}) };
      }
      r.stage = r.intent.kind === 'folder' && r.intent.again ? r.intent.destination : `${r.intent.destination}.helm-partial-${r.job.id}`;
      run.destinationKey = `${r.job.target.machineId}:${r.intent.destination}`;
      for (const [id, other] of this.running) if (id !== r.job.id && other.destinationKey === run.destinationKey) throw new Error('another send is using this destination; retry when it finishes');
      if (info.sendV2 !== true) {
        if (r.options.marker && info.precopiedHandoff !== true) throw new Error('target cannot receive copied task code; update Helm there');
        r.job.error = 'Older target: using helm copy; atomic publication and durable receiver receipts are unavailable.';
        if (plan.kind === 'file' && plan.name !== r.job.target.path.split('/').at(-1)) throw new Error('older target cannot rename a single file; use its original filename or update Helm there');
        if (!r.job.again && !r.attempted) {
          try {
            await this.rpc(r.job.target.machineId, M.FS_LIST, { path: r.job.target.path });
            if (!r.intent.defaultDestination) throw new Error('destination already exists; choose another path');
            if (plan.kind === 'file') throw new Error('older target already has this file; choose a new target folder or update Helm there');
            r.job.target.path += `-${r.job.id.slice(0, 8)}`;
          } catch (e) { if (!/ENOENT|no such file|no such folder/i.test(e.message)) throw e; }
        }
        r.attempted = true; r.job.phase = 'sending'; this.update(r, true);
        const progress = { write: chunk => {
          const text = String(chunk); const match = [...text.matchAll(/([\d,]+)B?\s+\d+%/g)].at(-1);
          if (match) { r.job.bytes.sent = Number(match[1].replaceAll(',', '')); this.update(r); }
        } };
        await this.copy({ machine: r.job.target.machineId, source: plan.path, targetFolder: plan.kind === 'file' ? dirname(r.job.target.path) : r.job.target.path,
          filterFile: plan.filterFile, excludes: plan.excludes, retries: 2 },
          { network: this.net(), stdout: progress, stderr: { write() {} }, signal: run.abort.signal });
        if (r.options.marker) {
          const { writeMarkerDir } = await import('./bulk-transfer.js');
          const marker = r.options.marker;
          const dir = writeMarkerDir(marker.handoffId, { body: marker.body, dir: marker.git ? 'helm-handoff' : 'handoff' });
          try {
            await this.copy({ machine: r.job.target.machineId, source: dir, targetFolder: `${r.job.target.path}/${marker.git ? '.git' : '.helm'}`, excludes: [], retries: 2 },
              { network: this.net(), stdout: { write() {} }, stderr: { write() {} }, signal: run.abort.signal });
          } finally { rmSync(dir, { recursive: true, force: true }); }
        }
      } else {
        if (!r.receipt) {
          r.attempted = true;
          await this.ensureServer();
          if (run.abort.signal.aborted) throw new Error('send cancelled');
          r.job.phase = 'sending'; this.update(r, true);
          const remote = [process.execPath, fileURLToPath(new URL('./send-proxy.js', import.meta.url)), this.socket, r.job.id].map(quote).join(' ');
          const flags = ['-a', '--no-owner', '--no-group', '--protect-args', '--mkpath', '--compress', '--compress-level=1', '--compress-choice=zstd', '--checksum-choice=xxh128', '--skip-compress=3g2/3gp/7z/avi/bz2/gif/gz/ico/jpeg/jpg/lz/lz4/mp3/mp4/mov/ogg/pdf/png/rar/webm/webp/xz/zip/zst', `--partial-dir=.helm-partial-${r.job.id}`, '--info=progress2', '--outbuf=L', '--stats', '--timeout=120'];
          // A folder sent again lands straight in the real folder, where the
          // other machine has its own files (installs, builds, agent work).
          // Only a private stage may be pruned to match the source.
          const own = r.stage !== r.intent.destination;
          if (own) flags.push('--delete-delay');
          if (r.intent.again) flags.push('--delay-updates');
          if (plan.filterFile) flags.push('--from0', '--filter', `merge ${plan.filterFile}`, ...(own ? ['--delete-excluded'] : []));
          for (const pattern of plan.excludes) flags.push('--exclude', pattern);
          let output = '', start = Date.now();
          const code = await new Promise((resolve, reject) => {
            const child = this.spawnProcess('rsync', [...flags, '-e', remote, '--', plan.path + (plan.kind === 'folder' ? '/' : ''), `${r.job.target.machineId}:${rsyncPath(r.stage)}/`], { stdio: ['ignore','pipe','pipe'], detached: process.platform !== 'win32' }); run.child = child;
            const abort = () => { try { if (process.platform !== 'win32') process.kill(-child.pid, 'SIGTERM'); else child.kill(); } catch {} };
            run.abort.signal.addEventListener('abort', abort, { once: true });
            child.stdout.on('data', chunk => {
              output = (output + chunk).slice(-16384);
              // rsync 3.5 writes "1,212,416B  38% 1,051,379B/s"; older ones leave out the B and the commas in the rate.
              const lines = [...output.matchAll(/([\d,]+)B?\s+\d+%\s+([\d.,]+)([kMGT]?)B\/s\s+(\d+):(\d+):(\d+).*?(?:xfr#(\d+))?/g)];
              const p = lines.at(-1); if (p) { r.job.bytes.sent = Number(p[1].replaceAll(',','')); r.job.rate = Number(p[2].replaceAll(',','')) * ({ '': 1, k: 1024, M: 1048576, G: 1073741824, T: 1099511627776 }[p[3]]); r.job.eta = Number(p[4])*3600+Number(p[5])*60+Number(p[6]); const x = output.match(/xfr#(\d+)/g)?.at(-1); if (x) r.job.files.sent = Number(x.slice(4)); this.update(r); }
            });
            child.stderr.on('data', c => { r.tail = ((r.tail ?? '') + c).slice(-8192); });
            child.once('error', reject); child.once('close', code => { run.abort.signal.removeEventListener('abort', abort); resolve(code); });
          });
          // The folder sent last time was deleted over there: send it fresh.
          if (code !== 0) await Promise.race([run.bridgeDone, new Promise(resolve => setTimeout(resolve, 2000))]).catch(() => {});
          if (code !== 0 && r.intent.again && !r.receipt && /previous send destination is missing/.test(r.tail ?? '')) {
            r.intent = { ...r.intent, again: false, defaultDestination: false }; r.job.again = false; r.tail = ''; run.bridge = null; run.bridgeDone = null;
            this.update(r, true);
            return this.perform(r, run);
          }
          r.job.phase = 'finishing'; this.timing('rsync-closed', { jobId: r.job.id }); this.update(r, true);
          if (code !== 0 || !r.receipt) throw new Error(r.tail?.trim() || `Send stopped (rsync ${code}); retry to resume.`);
          const changedFiles = /Number of regular files transferred:\s*([\d,]+)/.exec(output), changedBytes = /Total transferred file size:\s*([\d,]+)/.exec(output);
          r.job.changed = { files: Number(changedFiles?.[1]?.replaceAll(',','') ?? 0), bytes: Number(changedBytes?.[1]?.replaceAll(',','') ?? 0) };
          r.job.rate = r.job.changed.bytes / Math.max((Date.now()-start)/1000, 0.001);
        }
      }
      r.job.phase = 'done'; r.job.finishedAt = Date.now(); r.job.bytes.sent = plan.bytes; r.job.files.sent = plan.files; r.job.eta = 0; this.timing('job-done', { jobId: r.job.id }); this.update(r, true);
    } finally { endActivity(); }
  }
  async stop() {
    this.stopping = true;
    for (const run of this.running.values()) { run.abort.abort(); run.child?.kill('SIGTERM'); }
    await Promise.all([...this.running.values()].map(r => r.work));
    this.connections.close(); for (const socket of this.bridgeSockets) socket.destroy(); await new Promise(resolve => this.server ? this.server.close(resolve) : resolve()); rmSync(this.socket, { force: true });
  }
}
