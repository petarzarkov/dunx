import type {
  QueuesReport,
  RedisAbsent,
  RedisReport,
  RuntimeReport,
  Snapshot,
  StatsReport,
} from '../../../packages/dashboard/src/api/types';

export type {
  ConfigEntry,
  GatewayNode,
  Meta,
  ModuleNode,
  ProbeReport,
  ProviderNode,
  DbQueryStats,
  DbStatsReport,
  HistogramSnapshot,
  HttpStatsReport,
  QueuesReport,
  RedisAbsent,
  RedisReport,
  RouteNode,
  RouteStats,
  RuntimeReport,
  Snapshot,
  StatsAbsent,
  StatsHalf,
  StatsReport,
} from '../../../packages/dashboard/src/api/types';

/**
 * Every call is relative to the mount the server embedded, never to a path this
 * file guesses: the dashboard can be mounted anywhere, and an app behind a
 * reverse proxy at `/admin/_dunx` is the normal case rather than the exotic one.
 */
export class ApiError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

const parse = async (response: Response): Promise<unknown> => {
  try {
    return await response.json();
  } catch {
    return undefined;
  }
};

const request = async (url: string, init?: RequestInit): Promise<unknown> => {
  const response = await fetch(url, {
    // The mount is same-origin by construction, and the credentials matter:
    // `authorize` is usually a cookie session or a header a proxy adds.
    credentials: 'same-origin',
    ...init,
  });
  const body = await parse(response);
  if (!response.ok) {
    const error =
      typeof body === 'object' && body !== null && 'error' in body
        ? String((body as { error: unknown }).error)
        : response.statusText;
    throw new ApiError(response.status, error);
  }
  return body;
};

export class Api {
  readonly #base: string;

  constructor(basePath: string) {
    this.#base = `${basePath}/api`;
  }

  #url(path: string, params?: Record<string, string | number>): string {
    const url = new URL(`${this.#base}${path}`, window.location.origin);
    for (const [key, value] of Object.entries(params ?? {})) {
      url.searchParams.set(key, String(value));
    }
    return `${url.pathname}${url.search}`;
  }

  async snapshot(): Promise<Snapshot> {
    return (await request(this.#url('/snapshot'))) as Snapshot;
  }

  async runtime(): Promise<RuntimeReport> {
    return (await request(this.#url('/runtime'))) as RuntimeReport;
  }

  async queues(): Promise<QueuesReport> {
    return (await request(this.#url('/queues'))) as QueuesReport;
  }

  async redis(): Promise<RedisReport | RedisAbsent> {
    return (await request(this.#url('/redis'))) as RedisReport | RedisAbsent;
  }

  async stats(): Promise<StatsReport> {
    return (await request(this.#url('/stats'))) as StatsReport;
  }
}
