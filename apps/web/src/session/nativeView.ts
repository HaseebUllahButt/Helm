/** Providers whose native records Helm can render as a conversation. */
export const nativeConversation = (engine: string) =>
  ['claude', 'codex', 'opencode', 'opencode2', 'devin', 'grok', 'pi', 'omp', 'muse'].includes(engine);
