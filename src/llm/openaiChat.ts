import type { ChatMessage, CompletionRequest, CompletionResult, LLMProvider } from './types.js';
import { LLMError } from './types.js';

/**
 * Provider for any OpenAI-compatible /chat/completions endpoint:
 * OpenRouter, OpenAI, Ollama, LM Studio, LiteLLM, vLLM, Groq, ...
 */
export class OpenAIChatProvider implements LLMProvider {
  constructor(
    readonly name: string,
    private readonly opts: {
      baseUrl: string;
      apiKey?: string;
      model: string;
      temperature?: number;
      extraHeaders?: Record<string, string>;
      timeoutMs?: number;
    },
  ) {}

  async complete(req: CompletionRequest): Promise<CompletionResult> {
    const body: Record<string, unknown> = {
      model: req.model ?? this.opts.model,
      messages: req.messages.map(toWire),
    };
    const temperature = req.temperature ?? this.opts.temperature;
    if (temperature !== undefined) body.temperature = temperature;
    if (req.tools?.length) {
      body.tools = req.tools.map((t) => ({
        type: 'function',
        function: { name: t.name, description: t.description, parameters: t.parameters },
      }));
      body.tool_choice = 'auto';
    }

    const res = await fetchWithRetry(
      `${this.opts.baseUrl}/chat/completions`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(this.opts.apiKey ? { authorization: `Bearer ${this.opts.apiKey}` } : {}),
          ...this.opts.extraHeaders,
        },
        body: JSON.stringify(body),
      },
      3,
      this.opts.timeoutMs ?? 120_000,
    );

    const text = await res.text();
    if (!res.ok) throw new LLMError(`${this.name} HTTP ${res.status}: ${text.slice(0, 500)}`, res.status);

    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new LLMError(`${this.name}: keine JSON-Antwort (falsche Endpoint-URL?): ${text.slice(0, 200)}`);
    }
    const data = parsed as {
      choices?: { message?: { content?: string | null; tool_calls?: { id: string; function: { name: string; arguments: string } }[] } }[];
      usage?: { prompt_tokens?: number; completion_tokens?: number };
      error?: { message?: string };
    };
    if (data.error) throw new LLMError(`${this.name}: ${data.error.message ?? 'unknown error'}`);
    const msg = data.choices?.[0]?.message;
    if (!msg) throw new LLMError(`${this.name}: leere Antwort`);

    return {
      content: msg.content ?? null,
      toolCalls: (msg.tool_calls ?? []).map((tc, i) => ({
        id: tc.id || `call_${i}`,
        name: tc.function.name,
        arguments: tc.function.arguments || '{}',
      })),
      usage: { input: data.usage?.prompt_tokens, output: data.usage?.completion_tokens },
    };
  }
}

function toWire(m: ChatMessage): Record<string, unknown> {
  switch (m.role) {
    case 'system':
      return { role: 'system', content: m.content };
    case 'user':
      if (!m.images?.length) return { role: 'user', content: m.content };
      return {
        role: 'user',
        content: [
          { type: 'text', text: m.content },
          ...m.images.map((img) => ({ type: 'image_url', image_url: { url: `data:${img.mime};base64,${img.base64}` } })),
        ],
      };
    case 'assistant':
      return {
        role: 'assistant',
        content: m.content ?? '',
        ...(m.toolCalls?.length
          ? {
              tool_calls: m.toolCalls.map((tc) => ({
                id: tc.id,
                type: 'function',
                function: { name: tc.name, arguments: tc.arguments },
              })),
            }
          : {}),
      };
    case 'tool':
      return { role: 'tool', tool_call_id: m.toolCallId, content: m.content };
  }
}

/** Each attempt gets its own timeout – a shared AbortSignal would make every retry after a timeout fail at once. */
export async function fetchWithRetry(url: string, init: RequestInit, attempts = 3, timeoutMs?: number): Promise<Response> {
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetch(url, timeoutMs ? { ...init, signal: AbortSignal.timeout(timeoutMs) } : init);
      if ((res.status === 429 || res.status >= 500) && i < attempts - 1) {
        await sleep(1000 * 2 ** i);
        continue;
      }
      return res;
    } catch (err) {
      lastErr = err;
      if (i < attempts - 1) await sleep(1000 * 2 ** i);
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
