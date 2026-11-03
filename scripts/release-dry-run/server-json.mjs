/**
 * server.json, the MCP registry entry release.yml publishes, checked against
 * the schema its `$schema` names, so the registry won't turn it away.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { sh } from './shell.mjs';

/** Pinned so a dry run checks the same things every time. */
const VALIDATOR = 'check-jsonschema@0.38.2';

/** Throws when server.json in the repo at `root` breaks its `$schema`. */
export function checkServerJson(root) {
  const file = join(root, 'server.json');
  const schema = JSON.parse(readFileSync(file, 'utf8')).$schema;

  if (typeof schema !== 'string') {
    throw new Error('server.json has no $schema');
  }

  sh('uvx', [VALIDATOR, '--schemafile', schema, file]);
}
