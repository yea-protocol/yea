import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { shop } from '../../examples/shop.ts';
import * as P from '../src/index.js';
import { runMcpBridge } from '../src/mcp.js';

// The parts of the bridge's JSON-RPC messages these tests read.
interface RpcMessage {
  id: number;
  method?: string;
  result: {
    tools?: { name: string }[];
    content: { text: string }[];
    isError?: boolean;
  };
}

async function bridge(elicit: boolean) {
  process.env.YEA_HOME = mkdtempSync(join(tmpdir(), 'yea-'));

  const principal = await P.keyPair(),
    agent = await P.keyPair();

  writeFileSync(join(process.env.YEA_HOME, 'principal.key'), principal.seed);

  const grant = await P.issueGrant({
    principal,
    to: agent.public,
    caveats: [{ each: { of: 'spend', max: 1000, scale: 2, unit: 'USD' } }],
  });
  const client = new P.Client(P.local(shop({ trust: [principal.public] })), {
    key: agent.seed,
    grants: [grant],
  });
  const input = new PassThrough(),
    output = new PassThrough();
  const done = runMcpBridge([client], { input, output });
  const pending = new Map<number, (m: RpcMessage) => void>();
  let buf = '';

  output.setEncoding('utf8');
  output.on('data', (c: string) => {
    buf += c;

    for (let nl = buf.indexOf('\n'); nl >= 0; nl = buf.indexOf('\n')) {
      const m: RpcMessage = JSON.parse(buf.slice(0, nl));

      buf = buf.slice(nl + 1);

      if (m.method === 'elicitation/create') {
        input.write(
          `${JSON.stringify({
            jsonrpc: '2.0',
            id: m.id,
            result: { action: 'accept', content: { approve: true } },
          })}\n`,
        );
      } else {
        pending.get(m.id)?.(m);
      }
    }
  });

  let id = 0;
  const rpc = (method: string, params?: unknown) =>
    new Promise<RpcMessage>((res) => {
      pending.set(++id, res);
      input.write(
        `${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`,
      );
    });

  await rpc('initialize', {
    protocolVersion: '2025-06-18',
    capabilities: elicit ? { elicitation: {} } : {},
  });

  const tool = async (name: string, args: Record<string, unknown>) =>
    (await rpc('tools/call', { name, arguments: args })).result;

  const end = () => {
    input.end();

    return done;
  };

  return { rpc, tool, end };
}

describe('MCP bridge', () => {
  it('lists tools and returns Lens; consent via elicitation', async () => {
    const b = await bridge(true);
    const tools = (await b.rpc('tools/list')).result.tools?.map((t) => t.name);

    expect(tools).toContain('yea_commit');

    const found = await b.tool('yea_ask', {
      service: 'shop.example',
      capability: 'shop.search',
      params: { tag: 'vegan' },
      budget: 200,
    });

    expect(found.content[0].text).toMatch(/^items\[/);

    const props = await b.tool('yea_intent', {
      service: 'shop.example',
      capability: 'shop.order',
      params: { items: [{ sku: 'm001', qty: 2 }], deliver: '2030-01-01' },
    });
    const id = /\[(p_[^\]]+)\]/.exec(props.content[0].text)![1];
    const r = await b.tool('yea_commit', {
      service: 'shop.example',
      proposal: id,
    });

    expect(r.isError).toBeFalsy();
    expect(r.content[0].text).toContain('✓');
    await b.end();
  });

  it('without elicitation, tells the model to have the human approve', async () => {
    const b = await bridge(false);
    const props = await b.tool('yea_intent', {
      service: 'shop.example',
      capability: 'shop.order',
      params: { items: [{ sku: 'm001', qty: 2 }], deliver: '2030-01-01' },
    });
    const id = /\[(p_[^\]]+)\]/.exec(props.content[0].text)![1];
    const r = await b.tool('yea_commit', {
      service: 'shop.example',
      proposal: id,
    });

    expect(r.isError).toBe(true);
    expect(r.content[0].text).toContain('yea approve');
    await b.end();
  });
});
