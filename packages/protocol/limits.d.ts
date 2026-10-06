export interface LimitWindow { label: string; used: number; resetsAt?: number }
export function limitWindows(limits: unknown): LimitWindow[];
