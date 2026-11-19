// Gemini web (gemini.google.com). Selectors come from the working
// ask-neon script. Driven live on 2026-11-19: a temporary chat on Neon
// answered, and the address stayed /app (no saved conversation).
export default {
  id: 'gemini',
  label: 'Gemini',
  home: 'https://gemini.google.com/app',
  // Gemini has no address for a temporary chat: a button turns it on.
  temporaryUrl: null,
  temporaryButton: 'button[aria-label="Turn on temporary chat"]',
  temporaryOn: 'button[aria-label="Turn off temporary chat"]',
  // An address that names one saved conversation, with or without /u/<n>.
  conversation: '^https://gemini\\.google\\.com/(?:u/\\d+/)?app/[\\w-]+',
  editor: 'rich-textarea .ql-editor',
  send: 'button[aria-label*="Send" i]',
  stop: 'button[aria-label*="Stop" i]',
  reply: 'model-response',
  replyText: 'message-content',
  modelButton: 'button[aria-label*="mode picker" i]',
  modelItems: '[role="menuitemradio"], [role="menuitem"], [role="option"]',
  signIn: 'a[href*="ServiceLogin"], a[href*="accounts.google.com/signin"], a[aria-label="Sign in"]',
  signInPath: null,
};
