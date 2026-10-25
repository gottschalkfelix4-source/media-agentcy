export interface ImageInput {
  mime: string;
  base64: string;
}

export interface ToolCall {
  id: string;
  name: string;
  /** Raw JSON string as produced by the model. */
  arguments: string;
}

export type ChatMessage =
  | { role: 'system'; content: string }
  | { role: 'user'; content: string; images?: ImageInput[] }
  | { role: 'assistant'; content: string | null; toolCalls?: ToolCall[]; raw?: ProviderTurn }
  | { role: 'tool'; toolCallId: string; name: string; content: string };

/**
 * Provider-specific form of an assistant turn (e.g. Claude's thinking blocks). The agent passes it back
 * unchanged within the same tool loop; providers ignore turns from another provider.
 */
export interface ProviderTurn {
  provider: string;
  data: unknown;
}

export interface ToolSpec {
  name: string;
  description: string;
  /** JSON schema of the arguments object. */
  parameters: Record<string, unknown>;
}

export interface CompletionRequest {
  messages: ChatMessage[];
  tools?: ToolSpec[];
  model?: string;
  temperature?: number;
  /** 'none' = the model must answer without calling a tool (tools stay defined, history may contain tool calls). */
  toolChoice?: 'auto' | 'none';
}

export interface CompletionResult {
  content: string | null;
  toolCalls: ToolCall[];
  usage?: { input?: number; output?: number };
  raw?: ProviderTurn;
}

export interface LLMProvider {
  readonly name: string;
  complete(req: CompletionRequest): Promise<CompletionResult>;
  /** Model ids for the settings page, if the provider has its own way to list them. */
  listModels?(): Promise<string[]>;
}

export class LLMError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
  }
}
