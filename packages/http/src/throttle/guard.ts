import { Logger } from '@dunx/core';
import type { BunRequest } from 'bun';
import { UNMATCHED } from '../route/metadata.js';
import { ClientAddress } from '../server/client-address.js';
import type { RouteContext } from '../server/context.js';
import { HttpError } from '../server/errors.js';
import type { Middleware, Next } from '../server/middleware.js';
import { HttpStatusCode } from '../server/status.js';
import { SKIP_THROTTLE, THROTTLE, type ThrottleLimit } from './decorators.js';
import { ThrottleOptions } from './options.js';
import { ThrottleStore } from './store.js';

/**
 * A fixed-window rate limit, one key per subject and handler.
 *
 * Fails open: an unreachable store allows the request and warns once per process,
 * since refusing everything because the counter is down turns a degraded
 * dependency into a dead service.
 *
 * List it after any session guard - only the guard ahead knows whether to limit by
 * user id or by address, which is what `ThrottleOptions.subject` reads.
 *
 * The 429 is thrown, so it comes out in the app's own error shape.
 */
export class ThrottleGuard implements Middleware {
  #warned = false;

  constructor(
    private readonly options: ThrottleOptions,
    private readonly store: ThrottleStore,
    private readonly address: ClientAddress,
    private readonly logger: Logger,
  ) {}

  async handle(
    req: BunRequest,
    ctx: RouteContext,
    next: Next,
  ): Promise<Response> {
    // A path that matched nothing has no handler to limit, and counting it would
    // let a burst of 404s spend a real caller's budget - one Redis round trip per
    // miss, on the cheapest request to generate.
    if (ctx.get(UNMATCHED) === true) return next();
    if (ctx.get(SKIP_THROTTLE) === true) return next();

    const limit: ThrottleLimit = ctx.get(THROTTLE) ?? this.options;
    const key = this.#key(req, ctx);
    const used = await this.#hit(key, limit.windowSeconds);
    if (used === undefined) return next();

    if (used > limit.limit) {
      const after = (await this.#ttl(key)) ?? limit.windowSeconds;
      throw new HttpError(
        HttpStatusCode.TOO_MANY_REQUESTS,
        `Rate limit exceeded: ${limit.limit} requests per ` +
          `${limit.windowSeconds}s`,
        this.options.headers
          ? {
              headers: {
                'retry-after': String(after),
                'ratelimit-limit': String(limit.limit),
                'ratelimit-remaining': '0',
                'ratelimit-reset': String(after),
              },
            }
          : undefined,
      );
    }

    const response = await next();
    if (this.options.headers) {
      response.headers.set('ratelimit-limit', String(limit.limit));
      response.headers.set(
        'ratelimit-remaining',
        String(Math.max(0, limit.limit - used)),
      );
    }
    return response;
  }

  /**
   * Per **handler**, not per path: two verbs on one path get their own budgets,
   * and a parameterised path does not fragment into a key per id.
   */
  #key(req: BunRequest, ctx: RouteContext): string {
    const subject =
      (this.options.subject ?? ((request) => this.address.of(request)))(
        req,
        ctx,
      ) ?? 'anonymous';
    return `${this.options.prefix}:throttle:${ctx.controller}:${ctx.handler}:${subject}`;
  }

  async #hit(key: string, windowSeconds: number): Promise<number | undefined> {
    try {
      return await this.store.hit(key, windowSeconds);
    } catch (error) {
      this.#degraded(error);
      return undefined;
    }
  }

  async #ttl(key: string): Promise<number | undefined> {
    try {
      return await this.store.ttl(key);
    } catch (error) {
      this.#degraded(error);
      return undefined;
    }
  }

  #degraded(error: unknown): void {
    if (this.#warned) return;
    this.#warned = true;
    this.logger.warn(
      'The rate limiter is unreachable, so requests are not being counted.',
      { reason: (error as Error).message },
    );
  }
}
