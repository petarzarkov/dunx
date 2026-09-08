import { EventLoopLag } from '@dunx/core';
import {
  Controller,
  Get,
  HttpError,
  HttpStatusCode,
  RequestMetrics,
  SkipThrottle,
  type Input,
} from '@dunx/http';
import { QueryMetrics } from '@dunx/infra/db';
import { ApiDoc } from '@dunx/openapi';
import { z } from 'zod';
import { constructorExcerpt } from './source-excerpt.js';

/** Nanoseconds to milliseconds, or null where the histogram has no sample yet. */
const ms = (nanoseconds: number | undefined): number | null =>
  nanoseconds === undefined ? null : Number((nanoseconds / 1e6).toFixed(3));

/** What the DI panel may read. A `?file=` would be a traversal with a name. */
const SOURCES: Readonly<Record<string, string>> = {
  ledger: new URL('../database/ledger.service.ts', import.meta.url).pathname,
  gateway: new URL('../chat/chat.gateway.ts', import.meta.url).pathname,
};

/** Declared, so the parameter reaches the OpenAPI document and `Input` carries
 * its type. `SOURCES` still decides which names resolve. */
const sourceParams = {
  params: z.object({
    name: z
      .string()
      .max(32)
      .describe('Which class to show. One of: ledger, gateway.'),
  }),
} as const;

interface Vitals {
  readonly uptimeMs: number;
  readonly http: {
    readonly requests: number;
    readonly inFlight: number;
    readonly sockets: number;
    readonly since: string;
    readonly routes: readonly {
      readonly method: string;
      readonly route: string;
      readonly count: number;
      readonly p50Ms: number | null;
      readonly p99Ms: number | null;
    }[];
  };
  readonly db: {
    readonly queries: number;
    readonly operations: readonly {
      readonly operation: string;
      readonly count: number;
      readonly errors: number;
      readonly p99Ms: number | null;
    }[];
  };
  readonly loop: {
    readonly samples: number;
    readonly p99Ms: number | null;
    readonly maxMs: number | null;
  };
}

/** What the running process knows about itself, as JSON the landing page
 * renders: the public slice of what the dashboard shows, with no configuration
 * and no route bodies. `@SkipThrottle()` because the page polls it. */
@ApiDoc({
  tags: ['Demo'],
  description:
    'Request, query and event-loop numbers from the running process, plus the ' +
    'source of a class the container built. What the landing page renders.',
})
@Controller('demo')
@SkipThrottle()
export class VitalsController {
  readonly #booted = Date.now();

  constructor(
    private readonly requests: RequestMetrics,
    private readonly queries: QueryMetrics,
    private readonly lag: EventLoopLag,
  ) {}

  @Get('/vitals')
  vitals(): Vitals {
    const http = this.requests.snapshot();
    const db = this.queries.snapshot();
    const loop = this.lag.snapshot();

    return {
      uptimeMs: Date.now() - this.#booted,
      http: {
        requests: http.routes.reduce((total, route) => total + route.count, 0),
        // Both read off `Bun.serve` rather than counted, so dunx counts nothing.
        inFlight: http.inFlight,
        sockets: http.pendingWebSockets,
        since: http.since,
        routes: http.routes
          // Served off the unmatched path, so it would top the table always. Still in the snapshot.
          .filter((route) => route.route !== '(unmatched)')
          .sort((a, b) => b.count - a.count)
          .slice(0, 6)
          .map((route) => ({
            method: route.method,
            route: route.route,
            count: route.count,
            p50Ms: ms(route.duration.p50),
            p99Ms: ms(route.duration.p99),
          })),
      },
      db: {
        queries: db.total,
        operations: db.operations.map((operation) => ({
          operation: operation.operation,
          count: operation.count,
          errors: operation.errors,
          p99Ms: ms(operation.duration.p99),
        })),
      },
      loop: {
        samples: loop.count,
        p99Ms: ms(loop.p99),
        maxMs: ms(loop.max),
      },
    };
  }

  /** A class the container built, read off disk. Markup would have drifted. */
  @Get('/source/:name', sourceParams)
  async source({ params }: Input<typeof sourceParams>): Promise<{
    name: string;
    path: string;
    code: string;
  }> {
    const { name } = params;
    const path = SOURCES[name];
    if (path === undefined) {
      throw new HttpError(
        HttpStatusCode.NOT_FOUND,
        `no such source - try ${Object.keys(SOURCES).join(' or ')}`,
      );
    }

    return {
      name,
      path: `examples/full/src/${path.split('/src/')[1] ?? path}`,
      code: constructorExcerpt(await Bun.file(path).text()),
    };
  }
}
