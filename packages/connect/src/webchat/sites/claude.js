// Claude.ai web. Never opened in a test: the fixture in
// test/fixtures/webchat/claude.html copies the parts used here.
export default {
  id: 'claude',
  label: 'Claude.ai',
  home: 'https://claude.ai/new',
  // An incognito chat is not saved in the chat history.
  temporaryUrl: 'https://claude.ai/new?incognito',
  temporaryButton: null,
  temporaryOn: null,
  temporaryParam: 'incognito',
  conversation: '^https://claude\\.ai/chat/[\\w-]+',
  editor: 'div[contenteditable="true"].ProseMirror, [data-testid="chat-input"]',
  send: 'button[aria-label="Send message"], button[aria-label*="Send" i]',
  stop: 'button[aria-label="Stop response"], button[aria-label*="Stop" i]',
  reply: '[data-testid="assistant-message"], .font-claude-response, .font-claude-message',
  replyText: null,
  busy: '[data-is-streaming="true"]',
  modelButton: 'button[data-testid="model-selector-dropdown"]',
  modelItems: '[role="menuitemradio"], [role="menuitem"], [role="option"]',
  signIn: 'a[href="/login"], button[data-testid="login-with-google"]',
  signInPath: '^/login',
};
