/**
 * The Landing drift check (#75): every benchmark figure in landing/numbers.ts must match
 * bench/RESULTS.md and bench/agent-eval/RESULTS*.md, so re-running a benchmark can't leave the
 * page showing old numbers. It reads the results as they're committed; update numbers.ts with them.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const skip = process.features.typescript
  ? false
  : 'needs Node with type stripping (22.18+) to import .ts';
const read = (path) =>
  readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8');

/** A markdown table's body rows as arrays of trimmed cells (the header and rule rows dropped). */
function rows(md, header) {
  const lines = md.split('\n');
  const start = lines.findIndex((l) => l.startsWith(header));

  assert.ok(start >= 0, `no table starting ${header}`);

  const out = [];

  for (const line of lines.slice(start + 2)) {
    if (!line.startsWith('|')) {
      break;
    }

    out.push(
      line
        .slice(1, -1)
        .split('|')
        .map((c) => c.trim().replaceAll('**', '')),
    );
  }

  return out;
}

const number = (cell) => Number(cell.replace(/[$,%]/g, ''));

/** The live eval's table rows, by task and arm ('rest' or 'yea'). */
function liveRows() {
  const table = [
    ...rows(read('bench/agent-eval/RESULTS.md'), '| Task | Arm |'),
    ...rows(read('bench/agent-eval/RESULTS-injection.md'), '| Task | Arm |'),
  ];

  return table.map(
    ([task, arm, calls, tokens, cost, , success, violations]) => ({
      // The injection run's task has the same name as the plain order task.
      task,
      arm: arm === 'REST MCP' ? 'rest' : 'yea',
      calls: number(calls),
      tokens: number(tokens),
      cost: number(cost),
      success,
      violations,
    }),
  );
}

test('the live-agent figures match bench/agent-eval', { skip }, async () => {
  const { LIVE } = await import(
    '../.vitepress/theme/components/landing/numbers.ts'
  );
  const eval_ = read('bench/agent-eval/RESULTS.md');
  const injection = read('bench/agent-eval/RESULTS-injection.md');
  const live = liveRows();

  // Four tasks, in order: the three plain ones, then the injection run of the order task.
  assert.equal(live.length, LIVE.tasks.length * 2);
  LIVE.tasks.forEach((t, i) => {
    const [rest, yea] = live.slice(i * 2, i * 2 + 2);

    assert.equal(rest.arm, 'rest');
    assert.equal(yea.arm, 'yea');
    assert.equal(rest.cost, t.rest, `${t.task}: REST cost`);
    assert.equal(yea.cost, t.yea, `${t.task}: YEA cost`);

    if (i < 3) {
      assert.equal(rest.task, t.task);
    } else {
      assert.match(t.task, /injection/i);
    }
  });

  assert.match(eval_, new RegExp(`${LIVE.runs} runs per cell`));
  assert.match(eval_, /headless Claude Code/);

  for (const r of live) {
    assert.equal(r.success, `${LIVE.succeeded}/${LIVE.runs}`, r.task);
    assert.equal(r.violations, `${LIVE.violated}/${LIVE.runs}`, r.task);
  }

  assert.match(
    eval_,
    new RegExp(
      `\\$${LIVE.rules.each} on any single purchase or \\$${LIVE.rules.total} in total`,
    ),
  );
  assert.match(injection, new RegExp(`up to \\$${LIVE.injectedApproval}\\b`));
});

test('the shortcut run matches the reschedule runs', { skip }, async () => {
  const { LIVE } = await import(
    '../.vitepress/theme/components/landing/numbers.ts'
  );
  const runs = [
    ...read('bench/agent-eval/RESULTS.md').matchAll(
      /- \*\*reschedule · (\w+)\*\*: (\d+) calls, ([\d,]+) tokens/g,
    ),
  ].map(([, arm, calls, tokens]) => ({
    arm,
    calls: Number(calls),
    tokens: number(tokens),
  }));
  const yea = runs.filter((r) => r.arm !== 'rest');
  const shortcuts = yea.filter((r) => r.calls === LIVE.shortcut.yeaCalls);
  const k = (n) => `${Math.round(n / 1000)}k`;
  const [restMedian] = liveRows().filter(
    (r) => r.arm === 'rest' && r.task.startsWith('Move a meeting'),
  );

  assert.equal(shortcuts.length, 1, 'one run took the shortcut');
  assert.equal(LIVE.shortcut.runs, `1 of ${yea.length}`);
  assert.equal(LIVE.shortcut.yeaTokens, k(shortcuts[0].tokens));
  assert.equal(LIVE.shortcut.restCalls, restMedian.calls);
  assert.equal(LIVE.shortcut.restTokens, k(restMedian.tokens));
});

test('the payload figures match bench/RESULTS.md', { skip }, async () => {
  const { PAYLOAD } = await import(
    '../.vitepress/theme/components/landing/numbers.ts'
  );
  const table = rows(read('bench/RESULTS.md'), '| Task | Calls');
  const row = (start) => {
    const r = table.find(([task]) => task.startsWith(start));

    assert.ok(r, `no row starting ${start}`);

    return r;
  };
  const all = row('All tasks');

  assert.equal(number(all[2]), PAYLOAD.restMinified);
  assert.equal(number(all[4]), PAYLOAD.yea);
  assert.equal(number(all[5]), PAYLOAD.smallerThanMinified);
  assert.equal(number(all[6]), PAYLOAD.smallerThanPretty);
  assert.equal(
    number(row('Reschedule a meeting (REST: search')[5]),
    PAYLOAD.crudRescheduleSaving,
  );
  assert.equal(
    number(row('Reschedule a meeting (REST: one outcome')[5]),
    PAYLOAD.outcomeEndpointSaving,
  );
});
