// ChatGPT web (chatgpt.com). Never opened in a test: the fixture in
// test/fixtures/webchat/chatgpt.html copies the parts used here.
export default {
  id: 'chatgpt',
  label: 'ChatGPT',
  home: 'https://chatgpt.com/',
  temporaryUrl: 'https://chatgpt.com/?temporary-chat=true',
  temporaryButton: null,
  // The address keeps this mark while the temporary chat is open.
  temporaryOn: null,
  temporaryParam: 'temporary-chat=true',
  conversation: '^https://chatgpt\\.com/(?:g/[^/]+/)?c/[\\w-]+',
  editor: '#prompt-textarea',
  send: 'button[data-testid="send-button"]',
  stop: 'button[data-testid="stop-button"]',
  reply: '[data-message-author-role="assistant"]',
  replyText: '.markdown',
  modelButton: 'button[data-testid="model-switcher-dropdown-button"]',
  modelItems: '[role="menuitemradio"], [role="menuitem"], [role="option"]',
  signIn: 'button[data-testid="login-button"], a[href*="/auth/login"]',
  signInPath: '^/auth/',
};
