/**
 * Anthropic provider: request shape (caching, tools, images, fallbacks), thinking replay, recovery.
 * Uses a fake fetch, no network. Run: npm test
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AnthropicProvider } from '../src/llm/anthropic.js';
import type { ChatMessage, ToolSpec } from '../src/llm/types.js';

type Captured = { url: string; headers: Headers; body: any };

function fakeFetch(replies: (Record<string, unknown> | { status: number; error: string })[]) {
  const calls: Captured[] = [];
  const fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), headers: new Headers(init?.headers), body: init?.body ? JSON.parse(String(init.body)) : undefined });
    const r = replies.shift();
    if (!r) throw new Error('no reply left');
    if ('error' in r && typeof r.status === 'number') {
      return new Response(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: r.error } }), {
        status: r.status,
        headers: { 'content-type': 'application/json' },
      });
    }
    return new Response(JSON.stringify(r), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof globalThis.fetch;
  return { fetch, calls };
}

const message = (content: unknown[], extra: Record<string, unknown> = {}) => ({
  id: 'msg_1',
  type: 'message',
  role: 'assistant',
  model: 'claude-opus-5-5',
  content,
  stop_reason: 'end_turn',
  stop_sequence: null,
  usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 100, cache_creation_input_tokens: 20 },
  ...extra,
});

const tools: ToolSpec[] = [
  { name: 'search_media', description: 'Sucht', parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] } },
  { name: 'request_media', description: 'Fragt an', parameters: { type: 'object', properties: { tmdbId: { type: 'number' } } } },
];

test('request: cached tools + system, images, tool round trip, no temperature, fallbacks on the Claude API', async () => {
  const { fetch, calls } = fakeFetch([message([{ type: 'text', text: 'Hallo!' }])]);
  const llm = new AnthropicProvider({ apiKey: 'sk-ant-test', model: 'claude-opus-5-5', fetch });
  const messages: ChatMessage[] = [
    { role: 'system', content: 'Du bist ein Bot.' },
    { role: 'assistant', content: 'Ältere Antwort' },
    { role: 'user', content: 'Schau mal', images: [{ mime: 'image/jpeg', base64: 'AAAA' }, { mime: 'image/heic', base64: 'BBBB' }] },
    { role: 'assistant', content: null, toolCalls: [{ id: 'toolu_1', name: 'search_media', arguments: '{"query":"Dune"}' }] },
    { role: 'tool', toolCallId: 'toolu_1', name: 'search_media', content: '[{"title":"Dune"}]' },
    { role: 'user', content: '[SYSTEM-EREIGNIS] weiter' },
  ];
  const res = await llm.complete({ messages, tools, temperature: 0.4 });

  assert.equal(res.content, 'Hallo!');
  assert.deepEqual(res.usage, { input: 130, output: 5 });
  const { url, headers, body } = calls[0];
  assert.match(url, /^https:\/\/api\.anthropic\.com\/v1\/messages/);
  assert.equal(headers.get('authorization'), 'Bearer sk-ant-test'); // SDK 1.x sends the API key as Bearer
  assert.equal(headers.get('anthropic-version'), '2026-10-21');
  assert.match(headers.get('anthropic-beta') ?? '', /server-side-fallback-2026-07-01/);
  assert.equal(body.fallbacks, 'default');
  assert.equal(body.model, 'claude-opus-5-5');
  assert.equal(body.temperature, undefined);
  assert.deepEqual(body.cache_control, { type: 'ephemeral' });
  assert.deepEqual(body.system, [{ type: 'text', text: 'Du bist ein Bot.', cache_control: { type: 'ephemeral' } }]);
  assert.equal(body.tools[0].cache_control, undefined);
  assert.deepEqual(body.tools[1].cache_control, { type: 'ephemeral' });
  assert.equal(body.tools[0].input_schema.required[0], 'query');
  assert.deepEqual(body.tool_choice, { type: 'auto' });

  const roles = body.messages.map((m: any) => m.role);
  assert.deepEqual(roles, ['user', 'assistant', 'user', 'assistant', 'user'], 'starts with user, alternates');
  assert.equal(body.messages[0].content[0].text, '(Ältere Nachrichten ausgeblendet)');
  const userTurn = body.messages[2].content;
  assert.deepEqual(userTurn[0], { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: 'AAAA' } });
  assert.equal(userTurn.length, 2, 'unsupported image type dropped');
  assert.deepEqual(body.messages[3].content, [{ type: 'tool_use', id: 'toolu_1', name: 'search_media', input: { query: 'Dune' } }]);
  // Tool result and the following event text are merged into one user turn, result first.
  assert.equal(body.messages[4].content[0].type, 'tool_result');
  assert.equal(body.messages[4].content[0].tool_use_id, 'toolu_1');
  assert.equal(body.messages[4].content[1].text, '[SYSTEM-EREIGNIS] weiter');
});

test('no fallbacks through a proxy or for models without them; missing key is a clear error', async () => {
  const { fetch, calls } = fakeFetch([message([{ type: 'text', text: 'ok' }]), message([{ type: 'text', text: 'ok' }])]);
  await new AnthropicProvider({ apiKey: 'k', baseUrl: 'http://proxy:4000', model: 'claude-opus-5-5', fetch }).complete({ messages: [{ role: 'user', content: 'hi' }] });
  await new AnthropicProvider({ apiKey: 'k', model: 'claude-haiku-5-5', fetch }).complete({ messages: [{ role: 'user', content: 'hi' }] });
  assert.match(calls[0].url, /^http:\/\/proxy:4000\/v1\/messages/);
  for (const c of calls) {
    assert.equal(c.body.fallbacks, undefined);
    assert.equal(c.body.tools, undefined);
  }
  await assert.rejects(new AnthropicProvider({ model: 'claude-opus-5-5', fetch }).complete({ messages: [{ role: 'user', content: 'hi' }] }), /API-Key fehlt/);
});

test('thinking blocks come back unchanged within the tool loop; tool_choice none keeps the tools defined', async () => {
  const thinking = { type: 'thinking', thinking: '', signature: 'sig-abc' };
  const { fetch, calls } = fakeFetch([
    message([thinking, { type: 'tool_use', id: 'toolu_9', name: 'search_media', input: { query: 'Alien' } }], { stop_reason: 'tool_use' }),
    message([{ type: 'text', text: 'Gefunden.' }]),
  ]);
  const llm = new AnthropicProvider({ apiKey: 'k', model: 'claude-opus-5-5', fetch });
  const messages: ChatMessage[] = [{ role: 'user', content: 'Gibt es Alien?' }];
  const first = await llm.complete({ messages, tools });
  assert.deepEqual(first.toolCalls, [{ id: 'toolu_9', name: 'search_media', arguments: '{"query":"Alien"}' }]);

  messages.push({ role: 'assistant', content: first.content, toolCalls: first.toolCalls, raw: first.raw });
  messages.push({ role: 'tool', toolCallId: 'toolu_9', name: 'search_media', content: 'ok' });
  await llm.complete({ messages, tools, toolChoice: 'none' });

  const replay = calls[1].body;
  assert.deepEqual(replay.messages[1].content[0], thinking, 'thinking block replayed verbatim');
  assert.equal(replay.messages[1].content[1].type, 'tool_use');
  assert.deepEqual(replay.tool_choice, { type: 'none' });
  assert.equal(replay.tools.length, 2);
});

test('after a server-side fallback, the declined attempt is not echoed back', async () => {
  const { fetch } = fakeFetch([
    message([
      { type: 'thinking', thinking: '', signature: 'declined' },
      { type: 'fallback', from: { model: 'claude-opus-5-5' }, to: { model: 'claude-opus-4-8' } },
      { type: 'thinking', thinking: '', signature: 'rescue' },
      { type: 'text', text: 'Antwort' },
    ]),
  ]);
  const res = await new AnthropicProvider({ apiKey: 'k', model: 'claude-opus-5-5', fetch }).complete({ messages: [{ role: 'user', content: 'x' }] });
  assert.deepEqual(
    (res.raw!.data as { type: string; signature?: string }[]).map((b) => b.signature ?? b.type),
    ['rescue', 'text'],
  );
});

test('a rejected thinking signature is retried once without thinking blocks; refusals run no tools', async () => {
  const { fetch, calls } = fakeFetch([
    { status: 400, error: 'messages.1.content.0: Invalid `signature` in `thinking` block. The block is bound to a different conversation.' },
    message([{ type: 'text', text: 'ok' }]),
    message([{ type: 'tool_use', id: 'toolu_x', name: 'search_media', input: {} }], { stop_reason: 'refusal' }),
  ]);
  const llm = new AnthropicProvider({ apiKey: 'k', model: 'claude-opus-5-5', fetch });
  const messages: ChatMessage[] = [
    { role: 'user', content: 'a' },
    {
      role: 'assistant',
      content: null,
      toolCalls: [{ id: 'toolu_1', name: 'search_media', arguments: '{}' }],
      raw: { provider: 'anthropic', data: [{ type: 'thinking', thinking: '', signature: 's' }, { type: 'tool_use', id: 'toolu_1', name: 'search_media', input: {} }] },
    },
    { role: 'tool', toolCallId: 'toolu_1', name: 'search_media', content: 'ok' },
  ];
  assert.equal((await llm.complete({ messages, tools })).content, 'ok');
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[1].body.messages[1].content.map((b: any) => b.type), ['tool_use']);

  const refused = await llm.complete({ messages: [{ role: 'user', content: 'b' }], tools });
  assert.deepEqual(refused.toolCalls, []);
});

test('config: anthropic without a model uses claude-opus-5-5, other providers keep their default', async () => {
  const { buildConfig } = await import('../src/config.js');
  const a = buildConfig({ LLM_PROVIDER: 'anthropic', LLM_API_KEY: 'k' });
  assert.ok(a.ok);
  assert.equal(a.config.llm.model, 'claude-opus-5-5');
  assert.equal(a.config.llm.adminModel, 'claude-opus-5-5');
  assert.equal(a.config.llm.baseUrl, undefined);
  const o = buildConfig({ LLM_PROVIDER: 'openrouter', LLM_MODEL_ADMIN: 'x/y' });
  assert.ok(o.ok);
  assert.equal(o.config.llm.model, 'openai/gpt-4.1-mini');
  assert.equal(o.config.llm.adminModel, 'x/y');
});

test('model list for the settings page comes from /v1/models', async () => {
  const { fetch, calls } = fakeFetch([
    {
      data: [
        { id: 'claude-opus-5-5', type: 'model', display_name: 'Claude Opus 5.5', created_at: '2026-09-01T00:00:00Z' },
        { id: 'claude-haiku-5-5', type: 'model', display_name: 'Claude Haiku 5.5', created_at: '2026-09-01T00:00:00Z' },
      ],
      has_more: false,
      first_id: 'claude-opus-5-5',
      last_id: 'claude-haiku-5-5',
    },
  ]);
  const ids = await new AnthropicProvider({ apiKey: 'k', model: 'claude-opus-5-5', fetch }).listModels();
  assert.deepEqual(ids, ['claude-opus-5-5', 'claude-haiku-5-5']);
  assert.match(calls[0].url, /\/v1\/models/);
});
