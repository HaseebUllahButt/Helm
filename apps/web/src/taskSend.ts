import type { TaskTransferResult } from './client';
import { workspaceScope } from './workspaceCache';

export interface TaskSendRequest {
  handoffId: string;
  folder: string;
  sessionId?: string;
  targetMachineId: string;
  targetFolder?: string;
  profileId: string;
  model?: string;
  prompt: string;
  includeEnv: boolean;
  allowSkipped: boolean;
}
export interface SavedTaskSend { request: TaskSendRequest; result?: TaskTransferResult }

export const taskSendKey = (token: string | undefined, machine: string, folder: string, chat?: string) =>
  `helm.task-send:${JSON.stringify([workspaceScope(token) || 'local', machine, folder, chat ?? null])}`;

export function readTaskSend(key: string): SavedTaskSend | null {
  try {
    const text = localStorage.getItem(key);
    if (!text) return null;
    const value = JSON.parse(text) as SavedTaskSend;
    if (!/^[a-f0-9]{24}$/.test(value?.request?.handoffId) || !value.request.targetMachineId || !value.request.profileId) throw new Error();
    return value;
  } catch { throw new Error('Cannot read the saved task send. Check its target before sending another task.'); }
}

/** Save the exact request before sending. Reopening keeps its original identity. */
export function prepareTaskSend(key: string, request: TaskSendRequest): SavedTaskSend {
  const saved = readTaskSend(key);
  if (saved) return saved;
  const record = { request: JSON.parse(JSON.stringify(request)) };
  try { localStorage.setItem(key, JSON.stringify(record)); }
  catch { throw new Error('Cannot save this task send. No task was sent. Check browser storage and try again.'); }
  return record;
}

export function finishTaskSend(key: string, result: TaskTransferResult) {
  const saved = readTaskSend(key);
  if (saved) localStorage.setItem(key, JSON.stringify({ ...saved, result }));
}

export function forgetTaskSend(key: string) { localStorage.removeItem(key); }
