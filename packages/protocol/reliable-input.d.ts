export function newMessageId(): string;
export function retryableDelivery(error: unknown): boolean;
export function reliableInput<T>(rpc: (method: string, params: any, timeout: number) => Promise<T>, params: any,
  options?: { messageId?: string; timeout?: number; onRetry?: (messageId: string) => void; sleep?: (ms: number) => Promise<void> }): Promise<T>;
