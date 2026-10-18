/**
 * Local test chat without WhatsApp.
 *
 *   npm run chat                      → chat as test user +49 000 0000001
 *   npm run chat -- --as 4917612345   → chat as a specific number
 *   npm run chat -- --admin           → chat as the (first) admin
 *
 * Inside the chat:  /as <nummer|admin>  switch identity,  /poll  run notification check,  /quit
 */
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import type { Messenger } from '../agent/context.js';
import { createApp } from '../app.js';
import { config } from '../config.js';
import type { User } from '../db/repo.js';

const args = process.argv.slice(2);
const argVal = (name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};

const ADMIN_FALLBACK = '490000000000';
if (!config.ADMIN_NUMBERS.length) config.ADMIN_NUMBERS.push(ADMIN_FALLBACK);
// Chatting locally should not need an approval round-trip.
if (!args.includes('--strict')) (config as { UNKNOWN_USER_POLICY: string }).UNKNOWN_USER_POLICY = 'open';
(config as { DEBOUNCE_MS: number }).DEBOUNCE_MS = 0;

const c = { dim: '\x1b[2m', cyan: '\x1b[36m', yellow: '\x1b[33m', green: '\x1b[32m', reset: '\x1b[0m' };

let currentWaId = args.includes('--admin') ? config.ADMIN_NUMBERS[0] : (argVal('--as') ?? '490000000001').replace(/\D/g, '');
const pushName = argVal('--name') ?? 'Testnutzer';
let waiting: (() => void) | undefined;

const messenger: Messenger = {
  async sendText(user: User, text: string) {
    const isMe = user.wa_id === currentWaId;
    const who = user.display_name ?? user.push_name ?? user.wa_id;
    const color = isMe ? c.cyan : c.yellow;
    console.log(`\n${color}[Bot → ${who}${user.role === 'admin' ? ' (Admin)' : ''}]${c.reset}\n${text}\n`);
    if (isMe) waiting?.();
  },
  async setTyping(user: User, typing: boolean) {
    if (typing && user.wa_id === currentWaId) stdout.write(`${c.dim}…tippt${c.reset}\n`);
  },
};

const { router, poller } = createApp(messenger);
const rl = createInterface({ input: stdin, output: stdout });

console.log(`${c.green}Media Agentcy – lokaler Test-Chat${c.reset}`);
console.log(`${c.dim}LLM: ${config.llm.provider}/${config.llm.model} | DB: ${config.dbFile}`);
console.log(`Befehle: /as <nummer|admin>, /poll, /quit${c.reset}\n`);

for (;;) {
  const label = config.ADMIN_NUMBERS.includes(currentWaId) ? `admin ${currentWaId}` : currentWaId;
  const line = (await rl.question(`${c.green}${label}>${c.reset} `)).trim();
  if (!line) continue;
  if (line === '/quit' || line === '/exit') break;
  if (line.startsWith('/as ')) {
    const target = line.slice(4).trim();
    currentWaId = target === 'admin' ? config.ADMIN_NUMBERS[0] : target.replace(/\D/g, '');
    continue;
  }
  if (line === '/poll') {
    await poller.runOnce();
    console.log(`${c.dim}Poll abgeschlossen${c.reset}`);
    await new Promise((r) => setTimeout(r, 500));
    continue;
  }

  const replied = new Promise<void>((resolve) => {
    waiting = resolve;
    setTimeout(resolve, 180_000);
  });
  await router.onIncoming({ waId: currentWaId, pushName, text: line });
  await replied;
  waiting = undefined;
}

rl.close();
process.exit(0);
