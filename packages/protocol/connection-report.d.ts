export interface ConnectionRoutes {
  machines: { env?: string; name?: string; attached?: boolean; url?: string | null; direct?: { used?: boolean }; lastSeen?: number | null }[];
  history?: { env: string; state: string; at: number }[];
}
export interface ConnectionCheck { id: string; state: string; message: string; action?: string }
export function connectionChecks(routes: ConnectionRoutes, options?: { privateNames?: boolean; now?: number; machineIds?: (string | undefined)[] }): ConnectionCheck[];
export function connectionSupport(routes: ConnectionRoutes, now?: number, machineIds?: (string | undefined)[]): {
  checks: ConnectionCheck[]; history: { machine: string; state: string; at: number }[];
};
