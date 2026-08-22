import { Logger } from '@dunx/core';

interface Attempt {
  readonly status: number;
  readonly remaining: string | null;
  readonly retryAfter: string | null;
}

/**
 * Four requests at a limit of three, so the fourth is the 429 - and the headers
 * that tell a client when to come back.
 *
 * Every request here presents its own `x-api-key`, which the module reads as the
 * subject. Two runs of this demo therefore count separately, and so does anything
 * else hitting the same route.
 */
export class ThrottleDemo {
  constructor(private readonly logger: Logger) {}

  async demonstrate(url: string): Promise<void> {
    const key = `demo-${process.pid}`;
    const attempts = await this.hit(url, 'limits/burst', key, 4);

    this.logger.info(
      `@Throttle({ limit: 3, windowSeconds: 60 }) x4 -> ` +
        attempts.map((attempt) => attempt.status).join(', '),
    );
    this.logger.info(
      `ratelimit-remaining per attempt -> ` +
        attempts.map((attempt) => attempt.remaining ?? '-').join(', '),
    );

    const refused = attempts.at(-1);
    this.logger.info(
      refused?.status === 429
        ? `the 4th carries retry-after: ${refused.retryAfter}s`
        : `expected a 429 on the 4th, got ${refused?.status ?? 'nothing'}`,
    );

    // Six on an exempt route, which is past every limit in this app.
    const exempt = await this.hit(url, 'limits/exempt', key, 6);
    this.logger.info(
      `@SkipThrottle() x6 -> ${exempt.map((a) => a.status).join(', ')} ` +
        '(not counted at all)',
    );

    // A different key is a different budget, on the route that just refused one.
    const other = await this.hit(url, 'limits/burst', `${key}-other`, 1);
    this.logger.info(
      `same route, different x-api-key -> ${other[0]?.status ?? '-'} ` +
        '(the subject is what the window belongs to)',
    );
  }

  private async hit(
    url: string,
    path: string,
    key: string,
    times: number,
  ): Promise<readonly Attempt[]> {
    const attempts: Attempt[] = [];
    for (let i = 0; i < times; i += 1) {
      const response = await fetch(new URL(`api/${path}`, url), {
        headers: { 'x-api-key': key },
      });
      attempts.push({
        status: response.status,
        remaining: response.headers.get('ratelimit-remaining'),
        retryAfter: response.headers.get('retry-after'),
      });
    }
    return attempts;
  }
}
