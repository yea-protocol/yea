/**
 * The test drive's conversation: a real Claude model, the bridge's tools (host.ts), and the
 * person's approvals (person.ts). The model calls tools; the bridge runs them; when a result
 * carries a consent code, this loop asks the person before the model is answered.
 */
import type Anthropic from '@anthropic-ai/sdk';
import { est, printable } from '@yea-protocol/sdk';
import { bridge } from '../bridge.js';
import { connectHost, type Host } from './host.js';
import {
  type Confirm,
  type Person,
  review,
  terminalConfirm,
} from './person.js';
import { indent, paint } from './style.js';
import { POLICY_TEXT, throwaway } from './throwaway.js';

export interface TestDriveOptions {
  /** The Claude model. Default `claude-opus-5`. */
  model?: string;
  /** The task. Default: move a meeting, then order meals over the per-action limit. */
  prompt?: string;
  /** The most model turns. Default 20. */
  maxTurns?: number;
  /** The person's yes or no. Default: ask at the terminal, and approve nothing without a TTY. */
  confirm?: Confirm;
}

const day = (n: number) =>
  new Date(Date.now() + n * 86400e3).toISOString().slice(0, 10);

const DEFAULT_PROMPT = () =>
  `Move my 1:1 with Ana to a free slot on ${day(3)}. Then order me 4 vegan meals under 700 calories (2 each of two different meals) for delivery on ${day(2)}. Tell me exactly what happened.`;

/** Models that accept the server-side `fallbacks: "default"` chain. */
const FALLBACK_MODELS = new Set(['claude-opus-5', 'claude-fable-5-1']);

/** Running totals for the closing summary line. */
interface Usage {
  calls: number;
  toolTokens: number;
  inTok: number;
  outTok: number;
}

/** What one conversation needs: the model, the bridge's tools and the person who approves. */
interface Conversation {
  client: InstanceType<typeof Anthropic>;
  model: string;
  system: string;
  host: Host;
  person: Person;
}

/** The system prompt: the policy, how approval works here, then the bridge's instructions. */
const systemPrompt = (instructions: string) =>
  `You are an assistant acting on behalf of the user through YEA services. Your policy (signed by the user): ${POLICY_TEXT}. Anything beyond it needs the user's approval. Never try to work around a limit.\n\nIn this test drive the user approves in their own terminal as soon as a tool result carries a consent code, and you are told after that result whether they did. Don't ask them to run \`yea approve\` or to paste a consent, and don't call yea_consent.\n\n${instructions}`;

/** A tool result as the person watches it: the same text, with each consent code cut short. */
const shown = (text: string) =>
  text.replace(/\bpc1\.[\w-]{12,}/g, (code) => `${code.slice(0, 16)}…`);

/** Run one test drive, from a fresh throwaway world to the closing summary line. */
export async function drive(o: TestDriveOptions = {}) {
  const { default: AnthropicSDK } = await import('@anthropic-ai/sdk');
  const model = o.model ?? 'claude-opus-5';
  const prompt = o.prompt ?? DEFAULT_PROMPT();
  const world = await throwaway();
  const usage: Usage = { calls: 0, toolTokens: 0, inTok: 0, outTok: 0 };
  let host: Host | undefined;

  try {
    // The home is passed, never set in the environment: the bridge reads only this one.
    host = await connectHost(
      await bridge(world.clients, {
        home: world.home,
        consents: world.consents,
      }),
    );

    console.log(
      paint(
        `\nYEA test drive · ${model} · two example services, your policy: ${POLICY_TEXT}\n`,
        'b',
      ),
    );
    console.log(`${paint('👤 you:', 'yel')} ${prompt}`);

    const convo: Conversation = {
      client: new AnthropicSDK(),
      model,
      system: systemPrompt(host.instructions),
      host,
      person: {
        principal: world.principal,
        agent: world.agent,
        consents: world.consents,
        confirm: o.confirm ?? terminalConfirm,
      },
    };

    await converse(convo, prompt, o.maxTurns ?? 20, usage);
  } catch (e) {
    noCredentials(e);
  } finally {
    await host?.close();
    world.close();
  }

  console.log(
    paint(
      `\n${usage.calls} YEA calls · ${usage.toolTokens} tokens of YEA replies (Lens) · model usage ${usage.inTok} in / ${usage.outTok} out`,
      'dim',
    ),
  );
}

/** Say how to sign in when the API refused the credentials; rethrow anything else. */
function noCredentials(e: unknown) {
  const err = e as Error & { status?: number };

  if (err.status === 401 || /api key|authentication/i.test(err.message)) {
    console.error(
      paint(
        '\n✗ no Anthropic credentials. Set ANTHROPIC_API_KEY (or run `ant auth login`) and try again.',
        'red',
      ),
    );

    return;
  }

  throw e;
}

/** The agent loop: call the model, run the tools it asks for, repeat until it's done. */
async function converse(
  convo: Conversation,
  prompt: string,
  maxTurns: number,
  usage: Usage,
) {
  const messages: Anthropic.Beta.BetaMessageParam[] = [
    { role: 'user', content: prompt },
  ];

  for (let turn = 0; turn < maxTurns; turn++) {
    const response = await convo.client.beta.messages.create({
      model: convo.model,
      max_tokens: 16000,
      system: convo.system,
      tools: convo.host.tools,
      messages,
      ...(FALLBACK_MODELS.has(convo.model)
        ? {
            betas: ['server-side-fallback-2026-07-01'],
            fallbacks: 'default' as const,
          }
        : {}),
    });

    usage.inTok += response.usage.input_tokens;
    usage.outTok += response.usage.output_tokens;
    printText(response);

    const next = nextStep(response);

    if (next === 'stop') {
      break;
    }

    messages.push({ role: 'assistant', content: response.content });

    if (next === 'continue') {
      continue;
    }

    messages.push({
      role: 'user',
      content: await runTools(convo, next, usage),
    });
  }
}

function printText(response: Anthropic.Beta.BetaMessage) {
  for (const b of response.content) {
    if (b.type === 'text' && b.text.trim()) {
      console.log(
        `\n${paint(`🤖 ${response.model}:`, 'mag')} ${b.text.trim()}`,
      );
    }
  }
}

/** Whether to stop, continue a paused turn, or run these tool calls. */
function nextStep(
  response: Anthropic.Beta.BetaMessage,
): 'stop' | 'continue' | Anthropic.Beta.BetaToolUseBlock[] {
  if (response.stop_reason === 'refusal') {
    console.log(paint('\n(the model declined this request)', 'red'));

    return 'stop';
  }

  if (response.stop_reason === 'pause_turn') {
    return 'continue';
  }

  const uses = response.content.filter(
    (b): b is Anthropic.Beta.BetaToolUseBlock => b.type === 'tool_use',
  );

  if (!uses.length || response.stop_reason === 'end_turn') {
    return 'stop';
  }

  if (response.stop_reason === 'max_tokens') {
    throw new Error("the model's tool input was cut off (max_tokens)");
  }

  return uses;
}

/**
 * Run each tool call through the bridge. A result with consent codes goes to the person first,
 * and the model is told, after the bridge's own text, whether they approved.
 */
async function runTools(
  convo: Conversation,
  uses: Anthropic.Beta.BetaToolUseBlock[],
  usage: Usage,
): Promise<Anthropic.Beta.BetaToolResultBlockParam[]> {
  const results: Anthropic.Beta.BetaToolResultBlockParam[] = [];

  for (const u of uses) {
    console.log(
      `\n${paint(`   → ${printable(u.name)}`, 'cyan')} ${paint(JSON.stringify(u.input ?? {}), 'dim')}`,
    );

    const r = await convo.host.call(u.name, u.input);

    usage.calls++;
    usage.toolTokens += est(r.text);
    console.log(indent(shown(r.text)));

    const after = r.codes.length ? await review(convo.person, r.codes) : null;

    if (after) {
      console.log(paint(`   ${after}`, 'dim'));
    }

    results.push({
      type: 'tool_result',
      tool_use_id: u.id,
      content: after ? `${r.text}\n${after}` : r.text,
      ...(r.isError ? { is_error: true } : {}),
    });
  }

  return results;
}
