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
  | { role: 'assistant'; content: string | null; toolCalls?: ToolCall[] }
  | { role: 'tool'; toolCallId: string; name: string; content: string };

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
}

export interface CompletionResult {
  content: string | null;
  toolCalls: ToolCall[];
  usage?: { input?: number; output?: number };
}

export interface LLMProvider {
  readonly name: string;
  complete(req: CompletionRequest): Promise<CompletionResult>;
}

export class LLMError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
  }
}
