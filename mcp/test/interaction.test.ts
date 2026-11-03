/**
 * `requireInteraction` (SPEC-mcp-ts): Claude Code's prompt-on-every-call key goes on every tool
 * that acts (a job, a guarded tool, `undo`) and on no read, only when it's turned on.
 */
import { McpServer } from '@modelcontextprotocol/server';
import { describe, expect, it } from 'vitest';
import * as z from 'zod';
import type { JobConfig, YeaOptions } from '../src/index.js';
import { connect, refundJob, world } from './helpers.js';

const KEY = 'anthropic/requiresUserInteraction';

type RefundConfig = Partial<JobConfig<z.ZodObject<{ charge: z.ZodString }>>>;

/** Every tool a server lists, with its `_meta`: a job with revert, its undo, a guard and a read. */
async function listed(o: Partial<YeaOptions>, job: RefundConfig = {}) {
  const w = await world(o);
  const factory = () => {
    const server = new McpServer(
      { name: 'billing', version: '1' },
      w.approvals.serverOptions(),
    );
    const charge = server.registerTool(
      'charge',
      {
        inputSchema: z.object({ amount: z.string() }),
        _meta: { 'example.com/own': 1 },
      },
      () => ({ content: [] }),
    );

    server.registerTool(
      'balance',
      { annotations: { readOnlyHint: true } },
      () => ({ content: [] }),
    );
    w.approvals.job(server, 'refund', refundJob(w, job));
    w.approvals.guard(server, charge, {
      describe: () => ({ summary: 'Charge', effects: [] }),
    });

    return server;
  };
  const { tools } = await (await connect('2026', factory)).client.listTools();

  return Object.fromEntries(tools.map((t) => [t.name, t._meta ?? {}]));
}

/** Which listed tools carry the key. */
const prompted = (tools: Record<string, Record<string, unknown>>) =>
  Object.keys(tools)
    .filter((name) => tools[name][KEY] === true)
    .sort();

describe('requireInteraction', () => {
  it('is off by default: no tool carries the key', async () => {
    expect(prompted(await listed({}))).toEqual([]);
  });

  it('on, marks every tool that acts and no read', async () => {
    const tools = await listed({ requireInteraction: true });

    expect(Object.keys(tools).sort()).toEqual([
      'balance',
      'charge',
      'refund',
      'undo',
    ]);
    expect(prompted(tools)).toEqual(['charge', 'refund', 'undo']);
    // A guarded tool keeps its own _meta alongside the job's.
    expect(tools.charge).toMatchObject({ 'example.com/own': 1, [KEY]: true });
  });

  it("a job's own setting wins for that job; undo follows yea()'s", async () => {
    expect(prompted(await listed({}, { requireInteraction: true }))).toEqual([
      'refund',
    ]);
    expect(
      prompted(
        await listed(
          { requireInteraction: true },
          { requireInteraction: false },
        ),
      ),
    ).toEqual(['charge', 'undo']);
  });
});
