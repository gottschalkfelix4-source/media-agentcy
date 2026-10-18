export class ApiError extends Error {
  constructor(
    readonly service: string,
    readonly status: number,
    message: string,
  ) {
    super(`${service}: HTTP ${status} ${message}`);
  }
}

export interface ApiClientOptions {
  service: string;
  baseUrl: string;
  headers: Record<string, string>;
  timeoutMs?: number;
}

/** Small JSON REST client used by all media integrations. */
export class ApiClient {
  constructor(private readonly opts: ApiClientOptions) {}

  get service() {
    return this.opts.service;
  }

  async request<T = unknown>(
    method: string,
    path: string,
    opts: { query?: Record<string, string | number | boolean | undefined>; body?: unknown; headers?: Record<string, string> } = {},
  ): Promise<T> {
    const url = new URL(this.opts.baseUrl + path);
    for (const [k, v] of Object.entries(opts.query ?? {})) if (v !== undefined) url.searchParams.set(k, String(v));
    let res: Response;
    try {
      res = await fetch(url, {
        method,
        headers: {
          accept: 'application/json',
          ...(opts.body !== undefined ? { 'content-type': 'application/json' } : {}),
          ...this.opts.headers,
          ...opts.headers,
        },
        body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
        signal: AbortSignal.timeout(this.opts.timeoutMs ?? 20_000),
      });
    } catch (err) {
      throw new ApiError(this.opts.service, 0, `nicht erreichbar (${(err as Error).message})`);
    }
    const text = await res.text();
    if (!res.ok) throw new ApiError(this.opts.service, res.status, text.slice(0, 300));
    if (!text) return undefined as T;
    try {
      return JSON.parse(text) as T;
    } catch {
      return text as T;
    }
  }

  get<T = unknown>(path: string, query?: Record<string, string | number | boolean | undefined>, headers?: Record<string, string>) {
    return this.request<T>('GET', path, { query, headers });
  }

  post<T = unknown>(path: string, body?: unknown, query?: Record<string, string | number | boolean | undefined>, headers?: Record<string, string>) {
    return this.request<T>('POST', path, { body, query, headers });
  }

  put<T = unknown>(path: string, body?: unknown, query?: Record<string, string | number | boolean | undefined>) {
    return this.request<T>('PUT', path, { body, query });
  }

  delete<T = unknown>(path: string, query?: Record<string, string | number | boolean | undefined>) {
    return this.request<T>('DELETE', path, { query });
  }
}

/** Something added to the library, for "new this week". */
export interface RecentItem {
  type: 'movie' | 'series' | 'episode';
  /** Movie or series title (for episodes: the series). */
  title: string;
  year?: number;
  season?: number;
  added: string;
}

export function normalizeTitle(s: string) {
  return s
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/** Very small fuzzy score: 1 = exact, 0.8 = contains, otherwise word overlap ratio. */
export function titleScore(query: string, title: string) {
  const q = normalizeTitle(query);
  const t = normalizeTitle(title);
  if (!q || !t) return 0;
  if (q === t) return 1;
  if (t.includes(q) || q.includes(t)) return 0.8;
  const qw = new Set(q.split(' '));
  const tw = t.split(' ');
  const hit = tw.filter((w) => qw.has(w)).length;
  return (hit / Math.max(qw.size, tw.length)) * 0.7;
}

export function formatBytes(n?: number) {
  if (!n) return undefined;
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i++;
  }
  return `${n.toFixed(1)} ${units[i]}`;
}
