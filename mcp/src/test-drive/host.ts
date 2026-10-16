/**
 * The agent's side of the test drive: an MCP client connected in-process to the bridge (the one
 * tool host, as `yea mcp` serves it), and a thin adapter to the Claude API's tool use. It maps
 * `tools/list` to `tools` and a `CallToolResult` to a `tool_result`, and hands up the consent
 * codes the bridge put in a result's structured content. It loads no key and signs nothing.
 */
import type Anthropic from '@anthropic-ai/sdk';
import {
  type CallToolResult,
  Client as McpClient,
} from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { printable } from '@yea-protocol/sdk';
import type { BridgeFactory } from '../bridge.js';

/** A consent code the bridge handed out, and the proposal it is for. */
export interface Code {
  proposal: string;
  code: string;
}

/** One tool call's result: what the model is shown, and any consent codes in it. */
export interface HostResult {
  text: string;
  isError: boolean;
  codes: Code[];
}

export interface Host {
  /** The bridge's instructions, for the system prompt. */
  instructions: string;
  /** The bridge's tools, as the Claude API takes them. */
  tools: Anthropic.Beta.BetaTool[];
  call(name: string, input: unknown): Promise<HostResult>;
  close(): Promise<void>;
}

const isCode = (c: unknown): c is Code =>
  typeof c === 'object' &&
  c !== null &&
  typeof (c as Code).proposal === 'string' &&
  typeof (c as Code).code === 'string';

/** The bridge's consent codes in a result's structured content; none if it has no such list. */
export function codesOf(r: { structuredContent?: unknown }): Code[] {
  const s = r.structuredContent;
  const codes =
    typeof s === 'object' && s !== null
      ? (s as { codes?: unknown }).codes
      : undefined;

  return Array.isArray(codes) ? codes.filter(isCode) : [];
}

/** A tool result's text blocks, joined; anything else in it is named, not shown. */
function textOf(r: CallToolResult): string {
  return r.content
    .map((b) => (b.type === 'text' ? b.text : `[${b.type} content]`))
    .join('\n');
}

/** Tool arguments as an object: the model's input, or `{}` when it sent something else. */
const argsOf = (input: unknown): Record<string, unknown> =>
  typeof input === 'object' && input !== null && !Array.isArray(input)
    ? (input as Record<string, unknown>)
    : {};

/** Connect an MCP client to a server from `factory`, over the in-memory transport. */
export async function connectHost(factory: BridgeFactory): Promise<Host> {
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const client = new McpClient({ name: 'yea-test-drive', version: '0.1.0' });

  await factory().connect(serverSide);
  await client.connect(clientSide);

  const { tools } = await client.listTools();

  return {
    instructions: client.getInstructions() ?? factory.instructions,
    tools: tools.map((t) => ({
      name: t.name,
      description: t.description ?? '',
      input_schema: t.inputSchema as Anthropic.Beta.BetaTool.InputSchema,
    })),
    async call(name, input) {
      try {
        const r = (await client.callTool({
          name,
          arguments: argsOf(input),
        })) as CallToolResult;

        return {
          text: textOf(r),
          isError: r.isError === true,
          codes: codesOf(r),
        };
      } catch (e) {
        // A protocol error (an unknown tool, say) is the model's to read, not a crash.
        return {
          text: `✗ ${printable(e instanceof Error ? e.message : String(e))}`,
          isError: true,
          codes: [],
        };
      }
    },
    close: () => client.close(),
  };
}
