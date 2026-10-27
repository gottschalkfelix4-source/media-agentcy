import { GROK_API, type GrokAuth } from './grokAuth.js';
import { OpenAIChatProvider } from './openaiChat.js';
import { LLMError } from './types.js';

/**
 * Grok plan via xAI's OAuth sign-in: the OpenAI-compatible /chat/completions at api.x.ai with the
 * access token instead of an API key. Usage counts against the SuperGrok / X Premium+ subscription.
 */
export class GrokProvider extends OpenAIChatProvider {
  constructor(private readonly grok: { auth: GrokAuth; model: string; temperature?: number }) {
    super('grok', { baseUrl: GROK_API, token: (force) => grok.auth.accessToken(force), model: grok.model, temperature: grok.temperature });
  }

  async listModels(): Promise<string[]> {
    const get = async (force: boolean) =>
      fetch(`${GROK_API}/models`, {
        headers: { authorization: `Bearer ${await this.grok.auth.accessToken(force)}` },
        signal: AbortSignal.timeout(20_000),
      });
    let res = await get(false);
    if (res.status === 401) res = await get(true);
    if (!res.ok) throw this.httpError(res.status, await res.text().catch(() => ''));
    const data = (await res.json()) as { data?: { id: string }[] };
    // Image/video/voice models can't chat.
    return (data.data ?? []).map((m) => m.id).filter((id) => !/imagine|image|video|tts|voice|embed/i.test(id));
  }

  protected override httpError(status: number, text: string) {
    if (status === 403) {
      return new LLMError(
        'Grok-Abo: xAI erlaubt diesem Konto keinen API-Zugriff über die Anmeldung (HTTP 403). xAI schaltet das nur für bestimmte Abos frei (SuperGrok, X Premium+). Alternativ einen eigenen Anbieter mit xAI-API-Key anlegen (https://api.x.ai/v1).',
        status,
      );
    }
    if (status === 429) return new LLMError(`Grok-Abo: Nutzungslimit erreicht – später noch einmal versuchen. ${text.slice(0, 200)}`, status);
    return super.httpError(status, text);
  }
}
