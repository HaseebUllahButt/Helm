// The delivery ID belongs to the message, not to a socket or an RPC attempt.
// Only the receipt-backed method is retried. Older daemons and terminal
// keystrokes retain their one-attempt semantics.
export const newMessageId = () => Array.from(globalThis.crypto.getRandomValues(new Uint8Array(16)),
  byte => byte.toString(16).padStart(2, '0')).join('');

export function retryableDelivery(error) {
  if (error?.code) return ['offline', 'unreachable', 'timeout', 'disconnected', 'delivery_pending',
    'ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT'].includes(error.code);
  return /not connected|disconnected|connection closed|socket|timed out|fetch failed|ECONN|restarting/i.test(error?.message ?? '');
}

export async function reliableInput(rpc, params, { messageId = newMessageId(), timeout = 120_000,
  onRetry = () => {}, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)) } = {}) {
  const deadline = Date.now() + timeout;
  // Freeze the request once: editing a draft during reconnect cannot change
  // what this delivery ID means, including its images and context threads.
  const request = JSON.parse(JSON.stringify({ ...params, messageId }));
  for (let delay = 250; ; delay = Math.min(delay * 2, 2000)) {
    try {
      return await rpc('session.deliver', request, Math.max(1, Math.min(10_000, deadline - Date.now())));
    } catch (error) {
      if (['unknown_method', 'delivery_unsupported'].includes(error?.code)
          || /^unknown method: session\.deliver$/.test(error?.message ?? '')) {
        // An explicit rejection means this operation did nothing. Never
        // replay legacy input after a timeout or an ambiguous disconnect.
        return rpc('session.input', params, Math.max(1, deadline - Date.now()));
      }
      if (!retryableDelivery(error) || Date.now() + delay >= deadline) {
        if (retryableDelivery(error)) error.message += `; message ${messageId} is still unconfirmed - retry with the same delivery ID`;
        throw error;
      }
      onRetry(messageId);
      await sleep(delay);
    }
  }
}
