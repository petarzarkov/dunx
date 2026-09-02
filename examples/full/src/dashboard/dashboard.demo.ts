import { Logger } from '@dunx/core';
import type {
  QueuesReport,
  RuntimeReport,
  Snapshot,
  StatsReport,
} from '@dunx/dashboard';
/**
 * What the ops page shows, and a CI assertion that every panel's endpoint answers
 * against the real container. The JSON endpoints are supported, so
 * `curl $APP/api/_dunx/api/queues` works on a box with no browser.
 */
export class DashboardDemo {
  constructor(private readonly logger: Logger) {}

  async demonstrate(url: string): Promise<void> {
    const base = new URL('api/_dunx', url).href;

    // Mounted with no `authorize`, so it is open - the boot warning above. A
    // real service passes one, and a rejected caller gets 404 rather than 403.
    this.logger.info(
      'mounted with no authorize: open to anyone who can reach this port',
    );

    const read = async <T>(path: string): Promise<T> => {
      const response = await fetch(`${base}${path}`);
      return (await response.json()) as T;
    };

    const snapshot = await read<Snapshot>('/api/snapshot');
    this.logger.info(
      `snapshot -> ${snapshot.routes.length} routes, ${snapshot.gateways.length} gateways, ` +
        `${snapshot.modules.length} modules, ${snapshot.providers.length} providers`,
    );

    const unresolved = snapshot.providers.flatMap((provider) =>
      provider.dependencies.filter((dep) => 'unresolved' in dep),
    );
    this.logger.info(
      `unresolvable constructor parameters: ${unresolved.length} ` +
        '(each one would be a boot error naming that parameter)',
    );

    // Keys always, values only where `reveal` said so, decided at boot.
    const shown = (snapshot.config ?? []).filter((entry) => 'value' in entry);
    this.logger.info(
      `config -> ${snapshot.config?.length ?? 0} keys, ${shown.length} revealed: ` +
        shown.map((entry) => entry.key).join(', '),
    );

    const runtime = await read<RuntimeReport>('/api/runtime');
    this.logger.info(
      `runtime -> bun ${runtime.bun}, ` +
        `${Math.round(runtime.memory.heapUsed / 1024 / 1024)} MiB heap, probes: ` +
        `${runtime.probes.map((probe) => `${probe.name}=${probe.state}`).join(' ') || 'none'}`,
    );

    // Names only: everything about a queue is bull-board's, behind the same
    // `authorize`.
    const queues = await read<QueuesReport>('/api/queues');
    this.logger.info(
      queues.unavailable === undefined
        ? `queues -> ${queues.queues.join(', ')}, board at ${base}/queues`
        : `queues -> no board: ${queues.unavailable}`,
    );

    // Each half is independent: `configured: false` is what the panel reads to
    // say so rather than drawing an empty table.
    const stats = await read<StatsReport>('/api/stats');
    this.logger.info(
      `stats -> http ${stats.http.configured ? 'configured' : 'absent'}, ` +
        `db ${stats.db.configured ? 'configured' : 'absent'}`,
    );

    const page = await fetch(base);
    const html = await page.text();
    this.logger.info(
      `GET ${base} -> ${page.status} ${page.headers.get('content-type')}, ` +
        `${html.length} bytes, external requests: ` +
        `${/<script[^>]+src=|<link/.test(html) ? 'some' : 'none'}`,
    );
  }
}
