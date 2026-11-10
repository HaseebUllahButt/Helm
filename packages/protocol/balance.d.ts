import type { LimitWindow } from './limits';
export const OUT_AT: number;
export const ROOM_NEEDED: number;
export interface BalanceCandidate { key: string; engine: string; windows: LimitWindow[] }
export interface BalanceResult { key: string; switched: boolean; from?: string; until?: number | null; room?: number | null }
export function liveWindows(windows?: LimitWindow[], now?: number): LimitWindow[];
export function roomLeft(windows?: LimitWindow[], now?: number): number | null;
export function outUntil(windows?: LimitWindow[], now?: number): number | null;
export function isOut(windows?: LimitWindow[], now?: number): boolean;
export function balance(candidates: BalanceCandidate[], wanted: string, now?: number): BalanceResult;
export function pickRoomiest<T extends BalanceCandidate>(candidates: T[], now?: number): T | null;
