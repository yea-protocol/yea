/** What `yea()` tells the person at start-up (SPEC-mcp-ts `yea()`, SPEC-docs step 5). */
import { afterEach, expect, it, vi } from 'vitest';
import { yea } from '../src/index.js';
import { tmp } from './helpers.js';

afterEach(() => {
  delete process.env.YEA_HOME;
  vi.restoreAllMocks();
});

it('logs the service id to stderr once, when yea() is created', async () => {
  process.env.YEA_HOME = tmp();

  const lines: string[] = [];
  const stdout = vi.spyOn(console, 'log');

  vi.spyOn(console, 'error').mockImplementation((line: unknown) => {
    lines.push(String(line));
  });

  const approvals = yea({ name: 'files', transport: 'stdio' });
  const id = await approvals.serviceId();

  await approvals.serviceId();
  await new Promise((r) => setTimeout(r, 0));

  const logged = lines.filter((l) => l.startsWith('yea: service id'));

  expect(id).toMatch(/^ed25519:[A-Za-z0-9_-]{43}$/);
  expect(logged).toEqual([`yea: service id ${id} (name files)`]);
  expect(stdout).not.toHaveBeenCalled();
});
