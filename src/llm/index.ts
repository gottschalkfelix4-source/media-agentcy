import type { Config } from '../config.js';
import { AnthropicProvider } from './anthropic.js';
import { ChatGPTProvider } from './chatgpt.js';
import { chatgptAuth } from './chatgptAuth.js';
import { GrokProvider } from './grok.js';
import { grokAuth } from './grokAuth.js';
import { OpenAIChatProvider } from './openaiChat.js';
import type { LLMProvider } from './types.js';

export * from './types.js';

export function createProvider(config: Config): LLMProvider {
  const { llm } = config;
  switch (llm.provider) {
    case 'anthropic':
      return new AnthropicProvider({ apiKey: llm.apiKey, baseUrl: llm.baseUrl, model: llm.model });
    case 'chatgpt':
      return new ChatGPTProvider({ auth: chatgptAuth(llm.chatgptAuthFile), model: llm.model || undefined });
    case 'grok':
      return new GrokProvider({ auth: grokAuth(llm.grokAuthFile), model: llm.model, temperature: llm.temperature });
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
