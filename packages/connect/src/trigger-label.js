/** The event's name and target, without its request body or private address. */
export function describeEvent(event) {
  switch (event.kind) {
    case 'file-change': return `File change · ${event.path}`;
    case 'command-change': return `Command result change · Every ${event.everyMinutes} min`;
    case 'webhook': return 'Webhook POST';
    case 'chat-finished': return event.chatId ? `Chat ${event.chatId} finishes` : 'A chat or helper finishes';
    case 'machine-online': return `${event.machineName ?? event.machineId ?? 'A machine'} comes online`;
    default: return 'Event';
  }
}
