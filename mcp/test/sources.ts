/**
 * The source scans the security tests share (AGENTS.md rule 3): what signs, or loads a key to
 * sign with, and every production source in the repo. The import graph and its allowlist audit
 * are ts/test/imports.ts's, re-exported here.
 */
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { REPO } from '../../ts/test/imports.js';

export { importAudit, REPO, reachable } from '../../ts/test/imports.js';

/** What signs, or loads a key to sign with: the SDK's signers, and the principal key's file. */
export const SIGNS =
  /principalKey|consentGrant|issueGrant|delegateGrant|makeProof|signJobConsent|approveConsentCode|\bsigner\b|\bsign\(|\.seed\b.*sign|['"/]principal\.key/;

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
