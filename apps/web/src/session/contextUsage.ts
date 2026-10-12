/**
 * Claude's `/context` answer, read back into numbers.
 *
 * Claude prints it as markdown: a heading, the model, "used / size (pct)",
 * a table of categories, then a table per kind of thing loaded (memory
 * files, skills, MCP tools...). Anything that does not look like that is
 * left alone and shown as the text it is.
 */
export interface ContextPart { name: string; tokens: string; pct: number; kind: 'used' | 'free' | 'reserved' | 'unloaded' }
export interface ContextSection { title: string; rows: number; text: string }
export interface ContextUsage {
  model?: string;
  used: string;
  size: string;
  pct: number;
  parts: ContextPart[];
  sections: ContextSection[];
}

const cells = (line: string) => line.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
const isRule = (line: string) => /^\|?\s*:?-{2,}/.test(line.trim());

/** The body rows of the first markdown table in a block. */
function tableRows(block: string): string[][] {
  const lines = block.split('\n').filter((l) => l.trim().startsWith('|'));
  return lines.slice(1).filter((l) => !isRule(l)).map(cells);
}

export function parseContextUsage(text: string): ContextUsage | null {
  const s = text.trim();
  if (!/^##\s+Context Usage\b/.test(s)) return null;
  const tokens = /\*\*Tokens:\*\*\s*([\d.,]+\s*[kKmM]?)\s*\/\s*([\d.,]+\s*[kKmM]?)\s*\((\d+(?:\.\d+)?)%\)/.exec(s);
  if (!tokens) return null;
  const model = /\*\*Model:\*\*\s*(.+?)\s*$/m.exec(s)?.[1];
  const blocks = s.split(/^###\s+/m).slice(1);
  const parts: ContextPart[] = [];
  const sections: ContextSection[] = [];
  for (const block of blocks) {
    const nl = block.indexOf('\n');
    const title = (nl < 0 ? block : block.slice(0, nl)).trim();
    const body = nl < 0 ? '' : block.slice(nl + 1).trim();
    if (/usage by category/i.test(title)) {
      for (const [name, tok, pct] of tableRows(body)) {
        if (!name) continue;
        const kind: ContextPart['kind'] = /^free space$/i.test(name) ? 'free'
          : /autocompact|buffer/i.test(name) ? 'reserved'
          : /deferred/i.test(name) ? 'unloaded' : 'used';
        parts.push({ name, tokens: tok ?? '', pct: parseFloat(pct) || 0, kind });
      }
    } else if (body) {
      sections.push({ title, rows: tableRows(body).length, text: body });
    }
  }
  if (!parts.length) return null;
  return { model, used: tokens[1].replace(/\s+/g, ''), size: tokens[2].replace(/\s+/g, ''), pct: parseFloat(tokens[3]) || 0, parts, sections };
}
