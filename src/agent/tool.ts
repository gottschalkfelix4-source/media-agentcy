import { z } from 'zod';
import type { User } from '../db/repo.js';
import type { ToolSpec } from '../llm/index.js';
import type { AppContext } from './context.js';

export interface ToolContext extends AppContext {
  user: User;
  isAdmin: boolean;
  /**
   * The current agent run: when it started and what tools sent to the user meanwhile (stored in the chat
   * history). quiet = web console, tools must not message the user's WhatsApp.
   */
  turn: { startedAt: number; sent: string[]; quiet?: boolean };
}

export interface Tool<S extends z.ZodObject = z.ZodObject> {
  name: string;
  description: string;
  schema: S;
  run(args: z.infer<S>, ctx: ToolContext): Promise<unknown>;
}

export function defineTool<S extends z.ZodObject>(t: Tool<S>): Tool<S> {
  return t;
}

export function toSpec(t: Tool): ToolSpec {
  const schema = z.toJSONSchema(t.schema, { target: 'draft-7', io: 'input' }) as Record<string, unknown>;
  delete schema.$schema;
  return { name: t.name, description: t.description, parameters: schema };
}

/** Error whose message is meant for the model (expected failure, not a crash). */
export class ToolError extends Error {}

const MAX_RESULT_CHARS = 8000;

export async function executeTool(tools: Tool[], name: string, rawArgs: string, ctx: ToolContext): Promise<string> {
  const tool = tools.find((t) => t.name === name);
  if (!tool) return JSON.stringify({ error: `Unbekanntes Tool: ${name}` });
  let parsedJson: unknown;
  try {
    parsedJson = rawArgs.trim() ? JSON.parse(rawArgs) : {};
  } catch {
    return JSON.stringify({ error: 'Argumente sind kein gültiges JSON' });
  }
  const args = tool.schema.safeParse(parsedJson);
  if (!args.success) return JSON.stringify({ error: 'Ungültige Argumente', details: z.prettifyError(args.error) });
  try {
    const result = await tool.run(args.data, ctx);
    let out = JSON.stringify(result ?? { ok: true });
    if (out.length > MAX_RESULT_CHARS) out = out.slice(0, MAX_RESULT_CHARS) + '…(gekürzt)';
    return out;
  } catch (err) {
    const msg = (err as Error).message;
    if (!(err instanceof ToolError)) ctx.logger.warn({ err, tool: name }, 'Tool-Fehler');
    return JSON.stringify({ error: msg });
  }
}
