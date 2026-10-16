/**
 * A mock Claude Messages API for driving `yea test-drive` in tests: each request is answered by
 * the next scripted step, a tool call or text, and every tool result the test drive sends back
 * is recorded. Only the model is scripted; the bridge, the services and approval run for real.
 */
import { createServer, type IncomingHttpHeaders } from 'node:http';
import type { AddressInfo } from 'node:net';
import { vi } from 'vitest';

/** The parts of a Messages API request the mock reads. */
export interface MessagesRequest {
  model: string;
  fallbacks?: string;
  system: string;
  tools: { name: string; input_schema: { type: string } }[];
  messages: { content: string | { content: string; is_error?: boolean }[] }[];
}

/** A scripted reply block. */
export type Step =
  | { type: 'tool_use'; name: string; input: unknown }
  | { type: 'text'; text: string };

export interface MockMessages {
  requests: { headers: IncomingHttpHeaders; body: MessagesRequest }[];
  /** Each tool result's text, in the order the test drive sent them. */
  toolTexts: string[];
  close(): Promise<void>;
}

/** The tool results in a request's last message. */
function toolResults(r: MessagesRequest): string[] {
  const last = r.messages.at(-1)?.content;

  return Array.isArray(last) ? last.map((b) => b.content) : [];
}

/** The reply to the `n`th request: the step's block as a Messages API message. */
function reply(model: string, n: number, step: Step) {
  const block = step.type === 'tool_use' ? { ...step, id: `t${n}` } : step;

  return {
    id: `msg_${n}`,
    type: 'message',
    role: 'assistant',
    model,
    content: [block],
    stop_reason: step.type === 'tool_use' ? 'tool_use' : 'end_turn',
    stop_sequence: null,
    usage: { input_tokens: 100, output_tokens: 20 },
  };
}

/**
 * Serve `steps` on a local port and point the Anthropic SDK at it through the environment
 * (stubbed, so `vi.unstubAllEnvs()` restores it).
 */
export async function mockMessages(steps: Step[]): Promise<MockMessages> {
  const requests: MockMessages['requests'] = [];
  const toolTexts: string[] = [];
  const server = createServer(async (req, res) => {
    let body = '';

    for await (const c of req) {
      body += c;
    }

    const r: MessagesRequest = JSON.parse(body);

    requests.push({ headers: req.headers, body: r });
    toolTexts.push(...toolResults(r));

    const step = steps[requests.length - 1] ?? { type: 'text', text: 'done' };

    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(reply(r.model, requests.length, step)));
  });

  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  vi.stubEnv('ANTHROPIC_API_KEY', 'test');
  vi.stubEnv(
    'ANTHROPIC_BASE_URL',
    `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
  );

  return {
    requests,
    toolTexts,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

/** Run `fn` with console.log captured; returns everything it printed. */
export async function captureLog(fn: () => Promise<void>): Promise<string> {
  const logs: string[] = [];
  const log = vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => {
    logs.push(a.join(' '));
  });

  try {
    await fn();
  } finally {
    log.mockRestore();
  }

  return logs.join('\n');
}
