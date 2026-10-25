import Anthropic from '@anthropic-ai/sdk';
import type { ChatMessage, CompletionRequest, CompletionResult, LLMProvider, ToolCall } from './types.js';
import { LLMError } from './types.js';

/**
 * Native Claude provider (Messages API, API key from platform.claude.com).
 *
 * - Prompt caching: one breakpoint after the tool list (identical for every user of a role), one after the
 *   system prompt, plus automatic caching for the growing conversation.
 * - Thinking: newer models think adaptively by default. Their thinking blocks are passed back unchanged within
 *   one turn's tool loop (via `raw`); the stored history has only text, so nothing older is ever replayed.
 * - No temperature: API version 2026-10-21 (SDK 1.x) rejects sampling parameters.
 */

export const ANTHROPIC_DEFAULT_URL = 'https://api.anthropic.com';
const MAX_TOKENS = 16_000;
const IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'] as const;
type ImageType = (typeof IMAGE_TYPES)[number];

/** Models that support `fallbacks: "default"`: a declined request is re-run on another model server-side. */
const FALLBACK_MODELS = new Set(['claude-fable-5-1', 'claude-opus-5-5', 'claude-opus-5', 'claude-sonnet-5-5']);
const FALLBACK_BETA = 'server-side-fallback-2026-07-01';

type Block = Anthropic.Beta.BetaContentBlockParam;
type Message = Anthropic.Beta.BetaMessageParam;

export class AnthropicProvider implements LLMProvider {
  readonly name = 'anthropic';
  private readonly client: Anthropic;

  constructor(
    private readonly opts: { apiKey?: string; baseUrl?: string; model: string; timeoutMs?: number; fetch?: typeof fetch },
  ) {
    this.client = new Anthropic({
      apiKey: opts.apiKey ?? null,
      baseURL: opts.baseUrl ?? ANTHROPIC_DEFAULT_URL,
      timeout: opts.timeoutMs ?? 300_000,
      maxRetries: 2,
      ...(opts.fetch ? { fetch: opts.fetch } : {}),
    });
  }

  async complete(req: CompletionRequest): Promise<CompletionResult> {
    if (!this.opts.apiKey) throw new LLMError('Anthropic: API-Key fehlt (LLM_API_KEY, von platform.claude.com).');
    const model = req.model ?? this.opts.model;
    const { system, messages } = toAnthropic(req.messages);
    const tools = (req.tools ?? []).map(
      (t, i, all): Anthropic.Beta.BetaTool => ({
        name: t.name,
        description: t.description,
        input_schema: t.parameters as Anthropic.Beta.BetaTool.InputSchema,
        ...(i === all.length - 1 ? { cache_control: { type: 'ephemeral' as const } } : {}),
      }),
    );
    const fallback = FALLBACK_MODELS.has(model) && (this.opts.baseUrl ?? ANTHROPIC_DEFAULT_URL) === ANTHROPIC_DEFAULT_URL;

    const params = (msgs: Message[]): Anthropic.Beta.MessageCreateParamsNonStreaming => ({
      model,
      max_tokens: MAX_TOKENS,
      cache_control: { type: 'ephemeral' },
      ...(system ? { system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }] } : {}),
      messages: msgs,
      // Requests whose history holds tool_use blocks must define tools, so "no more tools" is tool_choice none.
      ...(tools.length ? { tools, tool_choice: { type: req.toolChoice ?? 'auto' } } : {}),
      ...(fallback ? { betas: [FALLBACK_BETA], fallbacks: 'default' as const } : {}),
    });

    let res: Anthropic.Beta.BetaMessage;
    try {
      res = await this.client.beta.messages.create(params(messages));
    } catch (err) {
      // A replayed thinking block the API no longer accepts (e.g. bound to a different prefix):
      // retry once without thinking blocks – that turn just runs without the earlier reasoning.
      if (err instanceof Anthropic.BadRequestError && /signature|thinking/i.test(err.message) && hasThinking(messages)) {
        try {
          res = await this.client.beta.messages.create(params(stripThinking(messages)));
        } catch (retryErr) {
          throw toLLMError(retryErr);
        }
      } else {
        throw toLLMError(err);
      }
    }
    return fromAnthropic(res);
  }

  async listModels(): Promise<string[]> {
    const ids: string[] = [];
    try {
      for await (const m of this.client.models.list({ limit: 100 })) ids.push(m.id);
    } catch (err) {
      throw toLLMError(err);
    }
    return ids;
  }
}

function toLLMError(err: unknown) {
  if (err instanceof LLMError) return err;
  if (err instanceof Anthropic.APIError) return new LLMError(`anthropic HTTP ${err.status ?? '?'}: ${err.message.slice(0, 500)}`, err.status);
  return new LLMError(`anthropic: ${err instanceof Error ? err.message : String(err)}`);
}

/** Our provider-neutral messages → Messages API (system separate, tool results as user blocks, same roles merged). */
export function toAnthropic(input: ChatMessage[]): { system: string; messages: Message[] } {
  const system: string[] = [];
  const messages: Message[] = [];
  const push = (role: 'user' | 'assistant', blocks: Block[]) => {
    if (!blocks.length) return;
    const last = messages.at(-1);
    if (last?.role === role) (last.content as Block[]).push(...blocks);
    else messages.push({ role, content: blocks });
  };

  for (const m of input) {
    switch (m.role) {
      case 'system':
        system.push(m.content);
        break;
      case 'user': {
        const images: Block[] = (m.images ?? [])
          .filter((img) => (IMAGE_TYPES as readonly string[]).includes(img.mime))
          .map((img) => ({ type: 'image', source: { type: 'base64', media_type: img.mime as ImageType, data: img.base64 } }));
        push('user', [...images, { type: 'text', text: m.content || '(leer)' }]);
        break;
      }
      case 'assistant':
        if (m.raw?.provider === 'anthropic') {
          push('assistant', m.raw.data as Block[]);
        } else {
          push('assistant', [
            ...(m.content ? [{ type: 'text' as const, text: m.content }] : []),
            ...(m.toolCalls ?? []).map((tc): Block => ({ type: 'tool_use', id: tc.id, name: tc.name, input: parseArgs(tc.arguments) })),
          ]);
        }
        break;
      case 'tool':
        push('user', [{ type: 'tool_result', tool_use_id: m.toolCallId, content: m.content }]);
        break;
    }
  }
  // The conversation has to start with the user; trimmed histories can start with a bot message.
  if (messages[0]?.role === 'assistant') messages.unshift({ role: 'user', content: [{ type: 'text', text: '(Ältere Nachrichten ausgeblendet)' }] });
  return { system: system.join('\n\n'), messages };
}

export function fromAnthropic(res: Anthropic.Beta.BetaMessage): CompletionResult {
  const texts: string[] = [];
  const toolCalls: ToolCall[] = [];
  for (const b of res.content) {
    if (b.type === 'text') texts.push(b.text);
    else if (b.type === 'tool_use') toolCalls.push({ id: b.id, name: b.name, arguments: JSON.stringify(b.input ?? {}) });
  }
  const u = res.usage;
  return {
    content: texts.join('\n').trim() || null,
    // A refusal or a cut-off answer may end in an incomplete tool call – never run those.
    toolCalls: res.stop_reason === 'refusal' || res.stop_reason === 'max_tokens' ? [] : toolCalls,
    usage: { input: (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0), output: u.output_tokens },
    raw: { provider: 'anthropic', data: echoContent(res.content) },
  };
}

/**
 * What goes back into the next request of the same tool loop. After a server-side fallback, blocks before the
 * last `fallback` marker came from the declined attempt: thinking and tool_use from there must not be echoed.
 */
function echoContent(content: Anthropic.Beta.BetaContentBlock[]): Block[] {
  const boundary = content.findLastIndex((b) => b.type === 'fallback');
  return content.filter(
    (b, i) => b.type !== 'fallback' && !(i < boundary && (b.type === 'thinking' || b.type === 'redacted_thinking' || b.type === 'tool_use')),
  ) as Block[];
}

const isThinking = (b: Block) => b.type === 'thinking' || b.type === 'redacted_thinking';

function hasThinking(messages: Message[]) {
  return messages.some((m) => Array.isArray(m.content) && m.content.some(isThinking));
}

function stripThinking(messages: Message[]): Message[] {
  return messages.map((m) => (m.role === 'assistant' && Array.isArray(m.content) ? { ...m, content: m.content.filter((b) => !isThinking(b)) } : m));
}

function parseArgs(raw: string): Record<string, unknown> {
  try {
    const v = JSON.parse(raw) as unknown;
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}
