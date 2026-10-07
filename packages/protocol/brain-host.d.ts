export function brainHost<T extends { id: string; name: string; kind?: string }>(machines: T[] | Record<string, T>): T | null;
