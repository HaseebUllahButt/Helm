// Claude uses task frames for both helpers and background services. A shell
// command or a passive watch does not keep the conversation working.
const SERVICE_TYPES = new Set(['local_bash', 'monitor_mcp', 'monitor_ws']);
const SERVICE_TOOLS = new Set(['Bash', 'Monitor', 'Artifact']);

export const nonAgentClaudeTask = (task) => SERVICE_TYPES.has(task?.type)
  || task?.ambient === true || task?.skipTranscript === true
  || task?.kind === 'command' || SERVICE_TOOLS.has(task?.name);
