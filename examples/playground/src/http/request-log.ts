import type { BunRequest } from 'bun';
import type { Middleware, Next } from '@dunx/http';
import { Logger } from '../logger.js';

/** The observable side effect: whatever the middleware saw is readable after. */
export class RequestLog {
  readonly entries: string[] = [];
}

/**
 * A class with `handle(req, next)`, resolved from the container — which is what
 * lets it inject. Chains are folded into one closure per route at boot.
 */
export class RequestLoggerMiddleware implements Middleware {
  constructor(
    private readonly log: RequestLog,
    private readonly logger: Logger,
  ) {}

  async handle(req: BunRequest, next: Next): Promise<Response> {
    const response = await next();
    const entry = `${req.method} ${new URL(req.url).pathname} -> ${response.status}`;
    this.log.entries.push(entry);
    this.logger.info(`middleware saw ${entry}`);
    response.headers.set('x-handled-by', 'request-logger');
    return response;
  }
}
