// YEA was called Parley: an existing ~/.parley moves to ~/.yea the first time it's needed.
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { home } from '../src/home.js';

const saved = { HOME: process.env.HOME, YEA_HOME: process.env.YEA_HOME };

afterEach(() => {
  process.env.HOME = saved.HOME;

  if (saved.YEA_HOME === undefined) {
    delete process.env.YEA_HOME;
  } else {
    process.env.YEA_HOME = saved.YEA_HOME;
  }
});

it('moves an old ~/.parley to ~/.yea, keeping its keys', () => {
  const h = mkdtempSync(join(tmpdir(), 'yea-home-'));

  mkdirSync(join(h, '.parley'));
  writeFileSync(join(h, '.parley', 'agent.key'), 'seed\n');
  process.env.HOME = h;
  delete process.env.YEA_HOME;

  expect(home()).toBe(join(h, '.yea'));
  expect(existsSync(join(h, '.yea', 'agent.key'))).toBe(true);
  expect(existsSync(join(h, '.parley'))).toBe(false);
});

it('is exported from the Node entry and honours YEA_HOME', async () => {
  const { home: fromNode } = await import('../src/node.js');

  process.env.YEA_HOME = '/tmp/yea-home-test';
  expect(fromNode()).toBe('/tmp/yea-home-test');
});
