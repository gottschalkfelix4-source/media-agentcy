import type { Config } from '../config.js';

/**
 * Voice messages → text via an OpenAI-compatible /audio/transcriptions endpoint (OpenAI Whisper, Groq,
 * a local faster-whisper server, ...). OpenRouter has no such endpoint, so it needs its own base URL.
 */

export interface SttConfig {
  baseUrl: string;
  apiKey?: string;
  model: string;
}

/** Undefined when voice is off or no endpoint is known. With LLM_PROVIDER=openai the LLM endpoint is reused. */
export function sttConfig(config: Config): SttConfig | undefined {
  if (!config.VOICE_ENABLED) return undefined;
  const reuseLlm = !config.STT_BASE_URL && config.llm.provider === 'openai';
  const baseUrl = config.STT_BASE_URL ?? (reuseLlm ? config.llm.baseUrl : undefined);
  if (!baseUrl) return undefined;
  return { baseUrl, apiKey: config.STT_API_KEY ?? (reuseLlm ? config.llm.apiKey : undefined), model: config.STT_MODEL };
}

function extension(mime: string) {
  if (mime.includes('ogg') || mime.includes('opus')) return 'ogg';
  if (mime.includes('mp4') || mime.includes('m4a') || mime.includes('aac')) return 'm4a';
  if (mime.includes('mpeg') || mime.includes('mp3')) return 'mp3';
  if (mime.includes('wav')) return 'wav';
  if (mime.includes('webm')) return 'webm';
  return 'ogg';
}

export async function transcribe(stt: SttConfig, audio: Uint8Array, mime = 'audio/ogg', fetchImpl: typeof fetch = fetch): Promise<string> {
  const type = mime.split(';')[0].trim() || 'audio/ogg';
  const form = new FormData();
  form.append('file', new Blob([new Uint8Array(audio)], { type }), `sprachnachricht.${extension(type)}`);
  form.append('model', stt.model);
  form.append('response_format', 'json');
  const res = await fetchImpl(`${stt.baseUrl.replace(/\/+$/, '')}/audio/transcriptions`, {
    method: 'POST',
    headers: stt.apiKey ? { authorization: `Bearer ${stt.apiKey}` } : undefined,
    body: form,
    signal: AbortSignal.timeout(90_000),
  });
  if (!res.ok) throw new Error(`Transkription fehlgeschlagen: HTTP ${res.status} ${(await res.text().catch(() => '')).slice(0, 200)}`);
  const data = (await res.json()) as { text?: string };
  return (data.text ?? '').trim();
}
