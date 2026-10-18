/**
 * Renders the README screenshots (docs/screenshots/*.png) and the Unraid icon from the demo server.
 * Uses a locally installed Chrome/Edge in headless mode via the DevTools protocol – no extra dependencies.
 *
 *   npm run build:web && npm run demo        (in one shell)
 *   npm run screenshots                       (in another)
 *
 * Env: DEMO_URL (default http://localhost:8090), DEMO_PASSWORD (default demo), CHROME (browser path).
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const BASE = process.env.DEMO_URL ?? 'http://localhost:8090';
const OUT = path.resolve(import.meta.dirname, '../docs/screenshots');
const ICON = path.resolve(import.meta.dirname, '../unraid/icon.png');
const PORT = 9333;

const shots: { name: string; path: string; width: number; height: number; scale?: number; mobile?: boolean; theme?: 'dark' | 'light' }[] = [
  { name: 'dashboard', path: '/', width: 1440, height: 900 },
  { name: 'users', path: '/users', width: 1440, height: 760 },
  { name: 'user-chat', path: '/users/3', width: 1440, height: 860 },
  { name: 'user-memory', path: '/users/2?tab=memory', width: 1440, height: 640 },
  { name: 'user-import', path: '/users/import', width: 1440, height: 900 },
  { name: 'ticket', path: '/tickets?id=1', width: 1440, height: 900 },
  { name: 'settings', path: '/settings?group=llm', width: 1440, height: 980 },
  { name: 'dashboard-light', path: '/', width: 1440, height: 900, theme: 'light' },
  { name: 'mobile', path: '/users/2', width: 390, height: 844, scale: 2, mobile: true },
];

function findBrowser() {
  const candidates = [
    process.env.CHROME,
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
  ];
  const found = candidates.find((c) => c && existsSync(c));
  if (!found) throw new Error('Kein Chrome/Edge gefunden – Pfad per CHROME=… angeben');
  return found;
}

/** Minimal DevTools-protocol client over the built-in WebSocket. */
async function connect(wsUrl: string) {
  const ws = new WebSocket(wsUrl);
  await new Promise((res, rej) => {
    ws.onopen = res;
    ws.onerror = rej;
  });
  let id = 0;
  const pending = new Map<number, { res: (v: any) => void; rej: (e: Error) => void }>();
  const listeners = new Map<string, (() => void)[]>();
  ws.onmessage = (e) => {
    const msg = JSON.parse(String(e.data));
    if (msg.id && pending.has(msg.id)) {
      const p = pending.get(msg.id)!;
      pending.delete(msg.id);
      if (msg.error) p.rej(new Error(msg.error.message));
      else p.res(msg.result);
    } else if (msg.method) {
      for (const l of listeners.get(msg.method) ?? []) l();
      listeners.delete(msg.method);
    }
  };
  return {
    send: (method: string, params: object = {}) =>
      new Promise<any>((res, rej) => {
        pending.set(++id, { res, rej });
        ws.send(JSON.stringify({ id, method, params }));
      }),
    once: (method: string) => new Promise<void>((res) => listeners.set(method, [...(listeners.get(method) ?? []), res])),
    close: () => ws.close(),
  };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const login = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password: process.env.DEMO_PASSWORD ?? 'demo' }),
  });
  if (!login.ok) throw new Error(`Login am Demo-Server fehlgeschlagen (${login.status}) – läuft "npm run demo"?`);
  const session = /ma_session=([^;]+)/.exec(login.headers.get('set-cookie') ?? '')?.[1];
  if (!session) throw new Error('Kein Session-Cookie erhalten');

  const browser = spawn(findBrowser(), [
    '--headless=new',
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${mkdtempSync(path.join(tmpdir(), 'ma-shots-'))}`,
    '--hide-scrollbars',
    '--no-first-run',
    '--lang=de-DE',
    'about:blank',
  ]);
  try {
    let target: { webSocketDebuggerUrl: string } | undefined;
    for (let i = 0; i < 50 && !target; i++) {
      await sleep(200);
      target = await fetch(`http://127.0.0.1:${PORT}/json/list`)
        .then((r) => r.json() as Promise<{ type: string; webSocketDebuggerUrl: string }[]>)
        .then((l) => l.find((t) => t.type === 'page'))
        .catch(() => undefined);
    }
    if (!target) throw new Error('Browser nicht erreichbar');
    const cdp = await connect(target.webSocketDebuggerUrl);
    await cdp.send('Page.enable');
    await cdp.send('Network.enable');
    await cdp.send('Network.setCookie', { name: 'ma_session', value: session, url: BASE, httpOnly: true });

    const go = async (url: string) => {
      const loaded = cdp.once('Page.loadEventFired');
      await cdp.send('Page.navigate', { url });
      await loaded;
    };

    mkdirSync(OUT, { recursive: true });
    for (const s of shots) {
      await cdp.send('Emulation.setDeviceMetricsOverride', { width: s.width, height: s.height, deviceScaleFactor: s.scale ?? 1.5, mobile: !!s.mobile });
      await cdp.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: s.theme ?? 'dark' }] });
      await go(`${BASE}${s.path}`);
      // Wait until all loading spinners are gone, then for animations to settle.
      for (let i = 0; i < 40; i++) {
        await sleep(250);
        const { result } = await cdp.send('Runtime.evaluate', { expression: "document.querySelectorAll('.animate-spin').length" });
        if (i >= 4 && result.value === 0) break;
      }
      await sleep(700);
      const { data } = await cdp.send('Page.captureScreenshot', { format: 'png' });
      writeFileSync(path.join(OUT, `${s.name}.png`), Buffer.from(data, 'base64'));
      console.log(`✓ ${s.name}.png`);
    }

    // App icon for Unraid: the favicon rendered at 512 px with a transparent background.
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 512, height: 512, deviceScaleFactor: 1, mobile: false });
    await cdp.send('Emulation.setDefaultBackgroundColorOverride', { color: { r: 0, g: 0, b: 0, a: 0 } });
    await go(`${BASE}/favicon.svg`);
    const { data } = await cdp.send('Page.captureScreenshot', { format: 'png' });
    mkdirSync(path.dirname(ICON), { recursive: true });
    writeFileSync(ICON, Buffer.from(data, 'base64'));
    console.log('✓ unraid/icon.png');
    cdp.close();
  } finally {
    browser.kill();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
