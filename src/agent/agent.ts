import type { User } from '../db/repo.js';
import type { ChatMessage, CompletionRequest, ImageInput } from '../llm/index.js';
import { adminTools } from './adminTools.js';
import type { AppContext } from './context.js';
import { adminSystemPrompt, SUMMARY_PROMPT, userSystemPrompt } from './prompts.js';
import { executeTool, toSpec, type Tool, type ToolContext } from './tool.js';
import { userTools } from './userTools.js';

export const EVENT_PREFIX = '[SYSTEM-EREIGNIS]';

type UsageKind = 'message' | 'event' | 'summary' | 'console';

export class Agent {
  private readonly userSpecs = userTools.map(toSpec);
  private readonly adminSpecs = adminTools.map(toSpec);

  constructor(private readonly ctx: AppContext) {}

  /** Handles a message from the user and returns the reply text. */
  async handleMessage(user: User, text: string, images?: ImageInput[], kind: UsageKind = 'message'): Promise<string> {
    const reply = await this.run(user, { role: 'user', content: text, images }, kind);
    this.ctx.repo.addMessage(user.id, 'user', images?.length ? `${text}\n[${images.length} Bild(er) gesendet]` : text);
    this.ctx.repo.addMessage(user.id, 'assistant', reply);
    void this.maybeSummarize(user.id);
    return reply;
  }

  /** Handles a system event (e.g. "your request is available") and returns the message for the user. */
  async handleEvent(user: User, eventText: string): Promise<string> {
    const content = `${EVENT_PREFIX} ${eventText}`;
    const reply = await this.run(user, { role: 'user', content }, 'event');
    this.ctx.repo.addMessage(user.id, 'event', content);
    this.ctx.repo.addMessage(user.id, 'assistant', reply);
    void this.maybeSummarize(user.id);
    return reply;
  }

  /** LLM call with usage tracking. Reads ctx.llm at call time so provider changes apply immediately. */
  private async complete(userId: number, kind: UsageKind, req: CompletionRequest) {
    const started = Date.now();
    const res = await this.ctx.llm.complete(req);
    this.ctx.repo.addUsage({ userId, kind, model: req.model, input: res.usage?.input, output: res.usage?.output, durationMs: Date.now() - started });
    return res;
  }

  private async run(user: User, incoming: Extract<ChatMessage, { role: 'user' }>, kind: UsageKind): Promise<string> {
    const { config, repo, services, logger } = this.ctx;
    const isAdmin = user.role === 'admin';
    const tools: Tool[] = isAdmin ? adminTools : userTools;
    const specs = isAdmin ? this.adminSpecs : this.userSpecs;
    const toolCtx: ToolContext = { ...this.ctx, user, isAdmin };

    const system = isAdmin ? adminSystemPrompt(config, services, repo, user) : userSystemPrompt(config, services, repo, user);
    const history: ChatMessage[] = repo.recentMessages(user.id, config.HISTORY_LIMIT).map((m) =>
      m.role === 'assistant' ? { role: 'assistant', content: m.content } : { role: 'user', content: m.content },
    );
    const messages: ChatMessage[] = [{ role: 'system', content: system }, ...history, incoming];
    const model = isAdmin ? config.llm.adminModel : config.llm.model;

    for (let round = 0; round < config.MAX_TOOL_ROUNDS; round++) {
      const res = await this.complete(user.id, kind, { messages, tools: specs, model });
      if (!res.toolCalls.length) {
        const text = res.content?.trim();
        return text || '🤔 Dazu fällt mir gerade nichts ein – kannst du es anders formulieren?';
      }
      messages.push({ role: 'assistant', content: res.content, toolCalls: res.toolCalls });
      for (const call of res.toolCalls) {
        logger.info({ user: user.id, tool: call.name, args: call.arguments.slice(0, 300) }, 'Tool-Aufruf');
        const output = await executeTool(tools, call.name, call.arguments, toolCtx);
        logger.debug({ tool: call.name, output: output.slice(0, 500) }, 'Tool-Ergebnis');
        messages.push({ role: 'tool', toolCallId: call.id, name: call.name, content: output });
      }
    }

    // Too many tool rounds: ask the model for a final answer without tools.
    messages.push({ role: 'user', content: `${EVENT_PREFIX} Tool-Limit erreicht. Fasse für den Nutzer zusammen, was du bisher herausgefunden/gemacht hast.` });
    const final = await this.complete(user.id, kind, { messages, model });
    return final.content?.trim() || 'Ich hänge gerade fest – ich gebe dem Admin Bescheid.';
  }

  private summarizing = new Set<number>();

  /** Rolls older messages into the user's long-term summary and extracts new facts. */
  private async maybeSummarize(userId: number) {
    const { config, repo, logger } = this.ctx;
    if (this.summarizing.has(userId)) return;
    const count = repo.unsummarizedCount(userId);
    if (count <= config.SUMMARIZE_AFTER) return;
    this.summarizing.add(userId);
    try {
      const user = repo.getUser(userId)!;
      const old = repo.oldestUnsummarized(userId, count - config.HISTORY_LIMIT);
      const facts = repo.listFacts(userId);
      const transcript = old.map((m) => `${m.created_at} ${m.role === 'assistant' ? 'Bot' : m.role === 'event' ? 'System' : 'Nutzer'}: ${m.content}`).join('\n');
      const res = await this.complete(userId, 'summary', {
        model: config.llm.model,
        messages: [
          { role: 'system', content: SUMMARY_PROMPT },
          {
            role: 'user',
            content: `Bisherige Zusammenfassung:\n${user.summary ?? '(keine)'}\n\nBekannte Fakten:\n${facts.map((f) => '- ' + f.fact).join('\n') || '(keine)'}\n\nÄltere Nachrichten:\n${transcript}`,
          },
        ],
      });
      const json = (res.content ?? '').match(/\{[\s\S]*\}/)?.[0];
      if (!json) throw new Error('Keine JSON-Antwort');
      const parsed = JSON.parse(json) as { summary?: string; newFacts?: string[] };
      if (parsed.summary) repo.updateUser(userId, { summary: parsed.summary.slice(0, 2000) });
      for (const f of parsed.newFacts ?? []) if (f && f.length < 300) repo.addFact(userId, f, 'summary');
      repo.markSummarized(userId, old[old.length - 1].id);
      logger.info({ user: userId, messages: old.length }, 'Gedächtnis zusammengefasst');
    } catch (err) {
      logger.warn({ err, user: userId }, 'Zusammenfassung fehlgeschlagen');
    } finally {
      this.summarizing.delete(userId);
    }
  }
}
