/**
 * The source scans the security tests share (AGENTS.md rule 3): what signs, or loads a key to
 * sign with; the files a relative import reaches; and every production source in the repo.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** The repo's root. */
export const REPO = fileURLToPath(new URL('../..', import.meta.url));

/** What signs, or loads a key to sign with: the SDK's signers, and the principal key's file. */
export const SIGNS =
  /principalKey|consentGrant|issueGrant|delegateGrant|makeProof|signJobConsent|approveConsentCode|\bsigner\b|\bsign\(|\.seed\b.*sign|['"/]principal\.key/;

/** Every source file reachable from `starts` through relative imports, type-only ones included. */
export function reachable(starts: string[]): string[] {
  const seen = new Set<string>();
  const queue = [...starts];

  for (let f = queue.pop(); f !== undefined; f = queue.pop()) {
    if (seen.has(f)) {
      continue;
    }

    seen.add(f);

    for (const m of readFileSync(f, 'utf8').matchAll(
      /from '(\.\.?\/[^']+)\.js'/g,
    )) {
      queue.push(join(dirname(f), `${m[1]}.ts`));
    }
  }

  return [...seen].sort();
}

/** Every production source: the SDK, this package, the CLI's bin and the connectors. */
export function productionSources(): string[] {
  const connectors = readdirSync(join(REPO, 'connectors'))
    .map((c) => join('connectors', c, 'src'))
    .filter((dir) => existsSync(join(REPO, dir)));

  return ['ts/src', 'mcp/src', 'cli/bin', ...connectors].flatMap((dir) =>
    readdirSync(join(REPO, dir), { recursive: true, encoding: 'utf8' })
      .filter((f) => /\.(ts|js|mjs)$/.test(f))
      .map((f) => join(REPO, dir, f)),
  );
}
