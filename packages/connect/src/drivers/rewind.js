/** Stage a Codex cut in a new provider thread. The source is never reverted. */
export async function stageCodexRewind(call, threadId, beforeTurnId) {
  const fork = await call('thread/fork', { threadId, persistExtendedHistory: true });
  const candidate = fork.thread?.id;
  if (!candidate || candidate === threadId) throw new Error('Codex did not create a separate recovery thread.');
  try {
    await call('thread/resume', { threadId: candidate, excludeTurns: true });
    try {
      await call('thread/revert', { threadId: candidate, beforeTurnId });
    } catch (error) {
      // Only an explicit unknown-method response permits the older protocol.
      // A timeout may have succeeded; never repeat an ambiguous mutation.
      if (error.code !== -32601) throw error;
      const read = await call('thread/read', { threadId: candidate, includeTurns: true });
      const turns = read.thread?.turns;
      const index = turns?.findIndex(turn => turn.id === beforeTurnId) ?? -1;
      if (index < 0) throw new Error('Codex cannot locate that rewind boundary.');
      await call('thread/rollback', { threadId: candidate, numTurns: turns.length - index });
    }
    return { engineSessionId: candidate, transcript: null, forkFrom: null, unsent: false };
  } catch (error) {
    // The source conversation is still authoritative, including on timeout.
    throw new Error(`Codex could not prepare rewind: ${error.message}`, { cause: error });
  }
}
