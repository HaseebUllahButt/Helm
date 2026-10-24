import { errorMessage } from '../errors';
import { useCallback, useEffect, useState } from 'react';
import type { Client, Environment } from '../client';

/**
 * The folder's git state, read from the machine. Kept apart from the Git
 * panel so a chat can show its branch and change count without loading the
 * panel's graph, diff and pipeline code until the Git button is tapped.
 */
export interface GitFile { path: string; status: 'M' | 'A' | 'D' | 'R' | '?'; staged: boolean; add: number; del: number }
export interface GitStatus {
  repo: boolean; root?: string; branch?: string | null; upstream?: string | null;
  ahead?: number; behind?: number; worktree?: boolean;
  head?: { commit: string; subject: string } | null;
  files?: GitFile[]; more?: number;
  /** The machine could not be asked; said in the Git sheet rather than hiding the button. */
  error?: string;
}

/** The folder's git state, refreshed when `key` changes - a turn ending is the usual reason. */
export function useGitStatus(client: Client, env: Environment, cwd: string, key: string) {
  const [status, setStatus] = useState<GitStatus | null>(null);
  const load = useCallback(() => {
    if (!env.online || !cwd) return;
    client.rpc<GitStatus>(env.id, 'git.status', { cwd }, 20_000).then(setStatus)
      .catch((error) => setStatus((now) => now?.repo ? now : { repo: false, error: errorMessage(error) }));
  }, [client, env.id, env.online, cwd]);
  useEffect(load, [load, key]);
  return { status, reload: load };
}
