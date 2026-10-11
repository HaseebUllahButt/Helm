export type MessageDeliveryTiming = 'tool' | 'loop' | 'turn';
export interface MessageDelivery {
  readonly timing: MessageDeliveryTiming;
  /** What a waiting message says about when it will be read. */
  readonly pending: string;
}
export function messageDelivery(engine?: string | null): MessageDelivery;
