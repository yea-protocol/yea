/**
 * The import graph of a set of TypeScript sources, and an allowlist audit over it (AGENTS.md
 * rule 3, #337). The code that reads a form answer may import only the modules a test lists, and
 * never loads code at run time, so a new way to sign (another process, Node's crypto, a key read
 * through a new module) fails until someone reviews it. mcp/test imports this by relative path.
 */
import { readFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

/** The repo's root. */
export const REPO = fileURLToPath(new URL('../..', import.meta.url));

/** Each `import … from '…'`, `export … from '…'` and side-effect `import '…'`, in source order. */
const SPECIFIER =
  /^(?:import|export)\s+(?:type\s+)?(?:[\w*{}\s,$]+?\s+from\s*)?['"]([^'"]+)['"]/gm;

/** What loads code, or reaches Node's internals, at run time: refused on the path, always. */
export const REFUSED =
  /\bimport\s*\(|\brequire\s*\(|createRequire|process\.(?:binding|_linkedBinding|dlopen)|\beval\s*\(|\bnew\s+Function\s*\(/g;

/** The module specifiers a source file imports or re-exports. */
export function importsOf(file: string): string[] {
  return [...readFileSync(file, 'utf8').matchAll(SPECIFIER)].map((m) => m[1]);
}

/** A relative specifier as the source file it names: `./x.js` is `./x.ts`. */
const sourceOf = (from: string, spec: string) =>
  join(dirname(from), spec.replace(/\.js$/, '.ts'));

/** Every source file reachable from `starts` through relative imports, type-only ones included. */
export function reachable(starts: string[]): string[] {
  const seen = new Set<string>();
  const queue = [...starts];

  for (let f = queue.pop(); f !== undefined; f = queue.pop()) {
    if (seen.has(f)) {
      continue;
    }

    seen.add(f);

    for (const spec of importsOf(f)) {
      if (spec.startsWith('.')) {
        queue.push(sourceOf(f, spec));
      }
    }
  }

  return [...seen].sort();
}

/**
 * Each import on the path from `starts` that isn't relative and isn't in `allowed`, and each
 * refused construct, as `file: specifier`. Empty means the path is as reviewed.
 */
export function importAudit(starts: string[], allowed: string[]): string[] {
  const out: string[] = [];

  for (const f of reachable(starts)) {
    const name = relative(REPO, f);

    for (const spec of importsOf(f)) {
      if (!spec.startsWith('.') && !allowed.includes(spec)) {
        out.push(`${name}: ${spec}`);
      }
    }

    for (const m of readFileSync(f, 'utf8').matchAll(REFUSED)) {
      out.push(`${name}: ${m[0]}`);
    }
  }

  return out;
}
