/**
 * The agent instructions `yea install` writes into CLAUDE.md, AGENTS.md and the like, as a
 * marker-fenced block (subagents don't see MCP server instructions).
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

const START = '<!-- YEA_START -->',
  END = '<!-- YEA_END -->';

export const AGENT_BLOCK = `${START}
## YEA: acting for the user

Each YEA capability is its own tool (for example \`shop_order\`), plus \`yea_consent\`, \`yea_undo\` and \`yea_expand\`. They act for the user under a policy they signed.
- Read-only tools never change anything. Tools marked destructive do things: call one with what the user asked for. It commits at once when the user's grant allows it (a \`✓\` receipt); otherwise it returns proposals (effects, cost, risk, undo) and nothing has happened.
- Over the grant, each proposal comes with a consent code. Ask the user to run \`yea approve <code>\` where their principal key is (the result says when to add \`--to\`) and paste the printed consent back, pass it to \`yea_consent\`, then call the same tool again with the same arguments. Never split or restructure a purchase to get under a limit.
- \`proposal: "<id>"\` commits one of the proposals the grant allows; \`preview: true\` only shows proposals. Commit only what the user asked for.
- Offer \`yea_undo\` if they change their mind within the undo window.
${END}
`;

export function writeBlock(file: string): string {
  const cur = existsSync(file) ? readFileSync(file, 'utf8') : '';
  const re = new RegExp(`${START}[\\s\\S]*?${END}\\n?`);
  const head =
    !cur && file.endsWith('.mdc')
      ? "---\ndescription: Using YEA tools on the user's behalf\nalwaysApply: true\n---\n\n"
      : '';
  const next = re.test(cur)
    ? cur.replace(re, AGENT_BLOCK)
    : head +
      cur +
      (cur && !cur.endsWith('\n') ? '\n' : '') +
      (cur ? '\n' : '') +
      AGENT_BLOCK;

  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, next);

  return file;
}

export function removeBlock(file: string): boolean {
  if (!existsSync(file)) {
    return false;
  }

  const cur = readFileSync(file, 'utf8');
  const next = `${cur
    .replace(new RegExp(`\\n?${START}[\\s\\S]*?${END}\\n?`), '\n')
    .trimEnd()}\n`;

  if (next === cur) {
    return false;
  }

  writeFileSync(file, next);

  return true;
}
