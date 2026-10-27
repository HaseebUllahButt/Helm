export function agentLabel(engine?: string | null): string;
export function notificationContext(session?: { title?: string | null; cwd?: string | null } | null): string;
export function notificationLine(text?: string | null, max?: number): string;
