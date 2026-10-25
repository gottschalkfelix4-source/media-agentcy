import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import type { ChatMessage, CompletionRequest, CompletionResult, LLMProvider, ToolCall } from './types.js';
import { LLMError } from './types.js';

/**
 * EXPERIMENTAL: uses a ChatGPT subscription (Plus/Pro) through the same backend the
 * official Codex CLI uses. Log in once with `npx @openai/codex login` on any machine
 * and copy ~/.codex/auth.json to CHATGPT_AUTH_FILE. Tokens are refreshed automatically.
 *
 * This is not a public API; OpenAI can change it at any time.
 */

const CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';
const TOKEN_URL = 'https://auth.openai.com/oauth/token';

interface CodexAuthFile {
  OPENAI_API_KEY?: string | null;
  tokens?: { id_token?: string; access_token: string; refresh_token: string; account_id?: string };
  last_refresh?: string;
}

export class ChatGPTCodexProvider implements LLMProvider {
  readonly name = 'chatgpt';
  private readonly sessionId = randomUUID();
  /** Parallel calls (several users, the summarizer) must share one refresh: the refresh token may be single-use. */
  private refreshing?: Promise<CodexAuthFile>;

  constructor(
    private readonly opts: { baseUrl: string; authFile: string; model: string },
  ) {}

  async complete(req: CompletionRequest): Promise<CompletionResult> {
    const { instructions, input } = toResponsesInput(req.messages);
    const body = {
      model: req.model ?? this.opts.model,
      instructions,
      input,
      tools: (req.tools ?? []).map((t) => ({
        type: 'function',
        name: t.name,
        description: t.description,
        parameters: t.parameters,
        strict: false,
      })),
      tool_choice: 'auto',
      parallel_tool_calls: false,
      store: false,
      stream: true,
      include: [],
    };

    let res = await this.post(body);
    if (res.status === 401) {
      await this.refresh();
      res = await this.post(body);
    }
    if (!res.ok || !res.body) {
      throw new LLMError(`chatgpt HTTP ${res.status}: ${(await res.text()).slice(0, 500)}`, res.status);
    }
    return parseSse(res);
  }

  private async post(body: unknown) {
    const auth = await this.auth();
    return fetch(`${this.opts.baseUrl}/responses`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'text/event-stream',
        authorization: `Bearer ${auth.tokens!.access_token}`,
        ...(auth.tokens!.account_id ? { 'chatgpt-account-id': auth.tokens!.account_id } : {}),
        'OpenAI-Beta': 'responses=experimental',
        originator: 'codex_cli_rs',
        session_id: this.sessionId,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(180_000),
    });
  }

  private readAuth(): CodexAuthFile {
    if (!existsSync(this.opts.authFile)) {
      throw new LLMError(
        `ChatGPT-Login fehlt: ${this.opts.authFile} nicht gefunden. Führe "npx @openai/codex login" aus und kopiere ~/.codex/auth.json dorthin.`,
      );
    }
    const auth = JSON.parse(readFileSync(this.opts.authFile, 'utf8')) as CodexAuthFile;
    if (!auth.tokens?.access_token || !auth.tokens.refresh_token) {
      throw new LLMError('auth.json enthält keine ChatGPT-Tokens (Login per API-Key wird hier nicht unterstützt).');
    }
    if (!auth.tokens.account_id) auth.tokens.account_id = accountIdFromJwt(auth.tokens.id_token ?? auth.tokens.access_token);
    return auth;
  }

  private async auth(): Promise<CodexAuthFile> {
    const auth = this.readAuth();
    const exp = jwtExp(auth.tokens!.access_token);
    if (exp && exp * 1000 - Date.now() < 5 * 60_000) return this.refresh();
    return auth;
  }

  private refresh(): Promise<CodexAuthFile> {
    this.refreshing ??= this.doRefresh().finally(() => (this.refreshing = undefined));
    return this.refreshing;
  }

  private async doRefresh(): Promise<CodexAuthFile> {
    const auth = this.readAuth();
    const res = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        client_id: CLIENT_ID,
        grant_type: 'refresh_token',
        refresh_token: auth.tokens!.refresh_token,
        scope: 'openid profile email',
      }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) throw new LLMError(`ChatGPT Token-Refresh fehlgeschlagen (${res.status}). Bitte neu einloggen.`, res.status);
    const data = (await res.json()) as { access_token: string; refresh_token?: string; id_token?: string };
    auth.tokens = {
      ...auth.tokens!,
      access_token: data.access_token,
      refresh_token: data.refresh_token ?? auth.tokens!.refresh_token,
      id_token: data.id_token ?? auth.tokens!.id_token,
    };
    auth.last_refresh = new Date().toISOString();
    writeFileSync(this.opts.authFile, JSON.stringify(auth, null, 2));
    return auth;
  }
}

function toResponsesInput(messages: ChatMessage[]) {
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
        if (m.content) input.push({ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: m.content }] });
        for (const tc of m.toolCalls ?? []) {
          input.push({ type: 'function_call', call_id: tc.id, name: tc.name, arguments: tc.arguments });
        }
        break;
      case 'tool':
        input.push({ type: 'function_call_output', call_id: m.toolCallId, output: m.content });
        break;
    }
  }
  return { instructions: system.join('\n\n'), input };
}

async function parseSse(res: Response): Promise<CompletionResult> {
  const reader = res.body!.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = '';
  const texts: string[] = [];
  const toolCalls: ToolCall[] = [];
  let usage: CompletionResult['usage'];

  const handle = (data: string) => {
    if (!data || data === '[DONE]') return;
    const ev = JSON.parse(data) as {
      type: string;
      item?: { type: string; content?: { type: string; text?: string }[]; call_id?: string; name?: string; arguments?: string };
      response?: { usage?: { input_tokens?: number; output_tokens?: number }; error?: { message?: string } };
      error?: { message?: string };
      message?: string;
    };
    if (ev.type === 'response.output_item.done' && ev.item) {
      if (ev.item.type === 'message') {
        for (const c of ev.item.content ?? []) if (c.type === 'output_text' && c.text) texts.push(c.text);
      } else if (ev.item.type === 'function_call') {
        toolCalls.push({ id: ev.item.call_id ?? randomUUID(), name: ev.item.name ?? '', arguments: ev.item.arguments ?? '{}' });
      }
    } else if (ev.type === 'response.completed') {
      usage = { input: ev.response?.usage?.input_tokens, output: ev.response?.usage?.output_tokens };
    } else if (ev.type === 'response.failed' || ev.type === 'error') {
      throw new LLMError(`chatgpt: ${ev.response?.error?.message ?? ev.error?.message ?? ev.message ?? 'Fehler'}`);
    }
  };

  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += value;
    let idx: number;
    while ((idx = buffer.indexOf('\n\n')) >= 0) {
      const chunk = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      const data = chunk
        .split('\n')
        .filter((l) => l.startsWith('data:'))
        .map((l) => l.slice(5).trim())
        .join('\n');
      handle(data);
    }
  }
  return { content: texts.join('\n') || null, toolCalls, usage };
}

function jwtPayload(token: string): Record<string, unknown> | undefined {
  try {
    return JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8')) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

function jwtExp(token: string) {
  const exp = jwtPayload(token)?.exp;
  return typeof exp === 'number' ? exp : undefined;
}

function accountIdFromJwt(token: string) {
  const claim = jwtPayload(token)?.['https://api.openai.com/auth'] as { chatgpt_account_id?: string } | undefined;
  return claim?.chatgpt_account_id;
}
