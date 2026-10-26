import { randomUUID } from 'node:crypto';
import { CHATGPT_API, USAGE_URL, type ChatGPTAuth } from './chatgptAuth.js';
import type { ChatMessage, CompletionRequest, CompletionResult, LLMProvider, ToolCall } from './types.js';
import { LLMError } from './types.js';

/**
 * ChatGPT plan usage via "Sign in with ChatGPT" (official flow for open-source apps):
 * the public Responses API at api.openai.com with the OAuth access token.
 * Preview rules: store=false, stream=true, the full context in `input`, system text in `instructions`,
 * function tools grouped in a namespace, no temperature/max_output_tokens/metadata/user.
 */

const NAMESPACE = 'media_agentcy';

type Item = Record<string, unknown> & { type: string };

export class ChatGPTProvider implements LLMProvider {
  readonly name = 'chatgpt';
  private defaultModel?: Promise<string>;

  constructor(private readonly opts: { auth: ChatGPTAuth; model?: string; fetch?: typeof fetch }) {}

  private get fetch() {
    return this.opts.fetch ?? fetch;
  }

  async complete(req: CompletionRequest): Promise<CompletionResult> {
    const model = req.model || this.opts.model || (await this.firstModel());
    const { instructions, input } = toResponsesInput(req.messages);
    const tools = req.tools?.length
      ? [
          {
            type: 'namespace',
            name: NAMESPACE,
            description: 'Werkzeuge des WhatsApp-Support-Bots (Mediathek, Anfragen, Tickets, Nutzer).',
            tools: req.tools.map((t) => ({ type: 'function', name: t.name, description: t.description, parameters: t.parameters, strict: false })),
          },
        ]
      : undefined;
    const body = {
      model,
      instructions,
      input,
      ...(tools ? { tools, tool_choice: req.toolChoice ?? 'auto', parallel_tool_calls: false } : {}),
      store: false,
      stream: true,
    };

    let res = await this.post('/responses', body, await this.opts.auth.accessToken());
    if (res.status === 401) res = await this.post('/responses', body, await this.opts.auth.accessToken(true));
    if (!res.ok || !res.body) throw await responseError(res);
    return parseStream(res);
  }

  async listModels(): Promise<string[]> {
    const res = await this.get('/models');
    if (!res.ok) throw await responseError(res);
    const data = (await res.json()) as { models?: { slug: string; visibility?: string }[]; data?: { id: string }[] };
    if (data.models) return data.models.filter((m) => !m.visibility || m.visibility === 'list').map((m) => m.slug);
    return (data.data ?? []).map((m) => m.id);
  }

  /** Without a configured model: the account's first listed model (server order = recommended order). */
  private firstModel() {
    this.defaultModel ??= this.listModels()
      .then((m) => {
        if (!m[0]) throw new LLMError('Für dieses ChatGPT-Konto sind keine Modelle verfügbar.');
        return m[0];
      })
      .catch((err) => {
        this.defaultModel = undefined;
        throw err;
      });
    return this.defaultModel;
  }

  private async get(path: string) {
    let res = await this.fetch(`${CHATGPT_API}${path}`, { headers: { authorization: `Bearer ${await this.opts.auth.accessToken()}` }, signal: AbortSignal.timeout(20_000) });
    if (res.status === 401) res = await this.fetch(`${CHATGPT_API}${path}`, { headers: { authorization: `Bearer ${await this.opts.auth.accessToken(true)}` }, signal: AbortSignal.timeout(20_000) });
    return res;
  }

  /** 503 = temporarily unavailable: a couple of bounded retries. 429 is a usage limit and must not be retried. */
  private async post(path: string, body: unknown, token: string) {
    for (let i = 0; ; i++) {
      const res = await this.fetch(`${CHATGPT_API}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'text/event-stream', authorization: `Bearer ${token}` },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(180_000),
      });
      if (res.status !== 503 || i >= 2) return res;
      await res.body?.cancel();
      await new Promise((r) => setTimeout(r, 1000 * 2 ** i));
    }
  }
}

/** Our messages → Responses input. Assistant turns from this provider are echoed as returned (function_call items). */
export function toResponsesInput(messages: ChatMessage[]) {
  const system: string[] = [];
  const input: unknown[] = [];
  for (const m of messages) {
    switch (m.role) {
      case 'system':
        system.push(m.content);
        break;
      case 'user':
        input.push({
          type: 'message',
          role: 'user',
          content: [
            { type: 'input_text', text: m.content },
            ...(m.images ?? []).map((img) => ({ type: 'input_image', image_url: `data:${img.mime};base64,${img.base64}` })),
          ],
        });
        break;
      case 'assistant':
        if (m.raw?.provider === 'chatgpt') {
          input.push(...(m.raw.data as Item[]));
          break;
        }
        if (m.content) input.push({ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: m.content }] });
        for (const tc of m.toolCalls ?? []) input.push({ type: 'function_call', call_id: tc.id, name: tc.name, arguments: tc.arguments });
        break;
      case 'tool':
        input.push({ type: 'function_call_output', call_id: m.toolCallId, output: m.content });
        break;
    }
  }
  return { instructions: system.join('\n\n'), input };
}

async function parseStream(res: Response): Promise<CompletionResult> {
  const reader = res.body!.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = '';
  const texts: string[] = [];
  const toolCalls: ToolCall[] = [];
  const echo: Item[] = [];
  let usage: CompletionResult['usage'];
  let completed = false;

  const handle = (data: string) => {
    if (!data || data === '[DONE]') return;
    const ev = JSON.parse(data) as {
      type: string;
      item?: Item & { content?: { type: string; text?: string }[]; call_id?: string; name?: string; namespace?: string; arguments?: string };
      response?: { usage?: { input_tokens?: number; output_tokens?: number }; error?: { code?: string; message?: string }; incomplete_details?: { reason?: string } };
      error?: { code?: string; message?: string };
      code?: string;
      message?: string;
    };
    if (ev.type === 'response.output_item.done' && ev.item) {
      const item = ev.item;
      if (item.type === 'message') {
        for (const c of item.content ?? []) if (c.type === 'output_text' && c.text) texts.push(c.text);
        echo.push(withoutId(item));
      } else if (item.type === 'function_call') {
        // Namespaced tools may come back as "<namespace>.<name>" or with a separate namespace field.
        const name = (item.name ?? '').replace(new RegExp(`^${NAMESPACE}[.:_]{1,2}`), '');
        toolCalls.push({ id: item.call_id ?? randomUUID(), name, arguments: item.arguments || '{}' });
        echo.push(withoutId(item));
      }
      // Reasoning items aren't echoed: with store=false they can't be referenced again.
    } else if (ev.type === 'response.completed') {
      completed = true;
      usage = { input: ev.response?.usage?.input_tokens, output: ev.response?.usage?.output_tokens };
    } else if (ev.type === 'response.incomplete') {
      throw new LLMError(`chatgpt: Antwort unvollständig (${ev.response?.incomplete_details?.reason ?? 'unbekannt'})`);
    } else if (ev.type === 'response.failed' || ev.type === 'error') {
      const err = ev.response?.error ?? ev.error ?? { code: ev.code, message: ev.message };
      throw new LLMError(describe(err.code, err.message));
    }
  };

  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += value;
      let idx: number;
      while ((idx = buffer.indexOf('\n\n')) >= 0) {
        const chunk = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        handle(
          chunk
            .split('\n')
            .filter((l) => l.startsWith('data:'))
            .map((l) => l.slice(5).trim())
            .join('\n'),
        );
      }
    }
  } catch (err) {
    await reader.cancel().catch(() => undefined);
    throw err;
  }
  if (!completed) throw new LLMError('chatgpt: Verbindung beendet, bevor die Antwort fertig war.');
  return { content: texts.join('\n').trim() || null, toolCalls, usage, raw: { provider: 'chatgpt', data: echo } };
}

const withoutId = ({ id: _id, ...rest }: Item) => rest as Item;

async function responseError(res: Response) {
  const text = await res.text().catch(() => '');
  let code: string | undefined;
  let message: string | undefined;
  try {
    const j = JSON.parse(text) as { error?: { code?: string; message?: string }; detail?: unknown };
    code = j.error?.code;
    message = j.error?.message ?? (typeof j.detail === 'string' ? j.detail : j.detail ? JSON.stringify(j.detail) : undefined);
  } catch {
    message = text.slice(0, 300);
  }
  const requestId = res.headers.get('x-request-id');
  return new LLMError(`${describe(code, message, res.status)}${requestId ? ` (Request-ID ${requestId})` : ''}`, res.status);
}

/** Error codes from OpenAI's plan-usage docs, with what the admin can do about them. */
function describe(code?: string, message?: string, status?: number) {
  switch (code) {
    case 'subscription_sharing_usage_limit_exceeded':
      return `ChatGPT-Abo: Nutzungslimit erreicht (Abo- oder App-Limit). Nutzung verwalten: ${USAGE_URL}`;
    case 'subscription_sharing_user_not_eligible':
      return 'ChatGPT-Abo: Für dieses Konto oder diesen Workspace ist die Nutzung in anderen Apps nicht verfügbar.';
    case 'subscription_sharing_usage_unavailable':
    case 'subscription_sharing_user_unavailable':
      return 'ChatGPT-Abo: gerade nicht verfügbar, bitte später noch einmal versuchen.';
    case 'subscription_sharing_invalid_user':
      return 'ChatGPT-Abo: Anmeldung nicht mehr gültig – bitte in der Web-Oberfläche neu verbinden.';
    case 'subscription_sharing_unsupported_capability':
      return `ChatGPT-Abo: nicht unterstützte Funktion${message ? ` – ${message}` : ''}`;
  }
  const head = `chatgpt${status ? ` HTTP ${status}` : ''}${code ? ` ${code}` : ''}`;
  return `${head}: ${message ?? 'Fehler'}`.slice(0, 500);
}
