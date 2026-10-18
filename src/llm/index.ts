import type { Config } from '../config.js';
import { ChatGPTCodexProvider } from './chatgptCodex.js';
import { OpenAIChatProvider } from './openaiChat.js';
import type { LLMProvider } from './types.js';

export * from './types.js';

export function createProvider(config: Config): LLMProvider {
  const { llm } = config;
  switch (llm.provider) {
    case 'chatgpt':
      return new ChatGPTCodexProvider({ baseUrl: llm.baseUrl!, authFile: llm.chatgptAuthFile, model: llm.model });
    case 'openrouter':
      return new OpenAIChatProvider('openrouter', {
        baseUrl: llm.baseUrl!,
        apiKey: llm.apiKey,
        model: llm.model,
        temperature: llm.temperature,
        extraHeaders: { 'HTTP-Referer': 'https://github.com/media-agentcy', 'X-Title': 'Media Agentcy' },
      });
    case 'openai':
    case 'custom':
      return new OpenAIChatProvider(llm.provider, {
        baseUrl: llm.baseUrl!,
        apiKey: llm.apiKey,
        model: llm.model,
        temperature: llm.temperature,
      });
  }
}
