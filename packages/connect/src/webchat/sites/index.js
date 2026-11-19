// The web chat sites Helm can use. To add a site, copy one of these files,
// change its addresses and selectors, and add it here. Each field is
// explained in ../page.js, which is the only code that reads them.
import gemini from './gemini.js';
import chatgpt from './chatgpt.js';
import claude from './claude.js';

export const SITES = { gemini, chatgpt, claude };

export function siteFor(id) {
  const site = SITES[id];
  if (!site) throw new Error(`Unknown site "${id}". Use one of: ${Object.keys(SITES).join(', ')}.`);
  return site;
}
