import { Logger } from '@dunx/core';
import type { QueuesReport, RuntimeReport, Snapshot } from '@dunx/dashboard';
/**
 * What the ops page shows, narrated - and, more usefully, an assertion in CI that
 * every panel's endpoint answers against the real container rather than a fixture.
 *
 * The JSON endpoints are the point of this demo as much as the page is: they are a
 * supported way to read the dashboard, not an implementation detail of the bundle,
 * which is what makes `curl $APP/api/_dunx/api/queues` a real answer on a box with
 * no browser.
 */
export class DashboardDemo {
  constructor(private readonly logger: Logger) {}

  async demonstrate(url: string): Promise<void> {
    const base = new URL('api/_dunx', url).href;

    // This example mounts the dashboard with **no** `authorize`, so it is open -
    // which is what the boot warning above is about, and what makes the page
    // explorable with `bun start`. A real service passes one, and a caller it
    // rejects gets 404 rather than 403 so a prober cannot tell the mount is there.
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

    // Keys always, values only where `reveal` said so - and the page has no
    // control to change that, because redaction is decided at boot.
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

    // Names only. Everything *about* a queue is bull-board's, mounted under the
    // same path and behind the same `authorize` - dunx renders no queue UI.
    const queues = await read<QueuesReport>('/api/queues');
    this.logger.info(
      queues.unavailable === undefined
        ? `queues -> ${queues.queues.join(', ')}, board at ${base}/queues`
        : `queues -> no board: ${queues.unavailable}`,
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
