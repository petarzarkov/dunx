import { Logger } from '@dunx/core';
import type { HttpApp } from '@dunx/http';
import { AppConfigService } from '../config.js';
import { RequestTrail } from './request-trail.js';

const CORS_HEADERS = [
  'access-control-allow-origin',
  'access-control-allow-methods',
  'access-control-allow-headers',
  'access-control-allow-credentials',
  'access-control-max-age',
] as const;

const describeCors = (response: Response): string =>
  CORS_HEADERS.map(
    (header) =>
      `${header.slice('access-control-'.length)}=${response.headers.get(header) ?? '-'}`,
  ).join(' ');

const preflight = (url: string, origin: string): Promise<Response> =>
  fetch(new URL('api/notes', url), {
    method: 'OPTIONS',
    headers: {
      origin,
      'access-control-request-method': 'POST',
      'access-control-request-headers': 'content-type',
    },
  });

const postNote = (url: string, text: unknown): Promise<Response> =>
  fetch(new URL('api/notes', url), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text }),
  });

/** `203.0.113.7` is what the caller sent, `10.0.0.1` what the one proxy
 * appended. With `trust proxy` at one hop, only the second counts. */
const whoami = async (url: string, forwarded: boolean): Promise<string> => {
  const response = await fetch(new URL('api/notes/whoami', url), {
    headers: forwarded ? { 'x-forwarded-for': '203.0.113.7, 10.0.0.1' } : {},
  });
  const { ip } = (await response.json()) as { ip: string | undefined };
  return ip ?? '(none)';
};

export class HttpDemo {
  constructor(
    private readonly trail: RequestTrail,
    private readonly config: AppConfigService,
    private readonly logger: Logger,
  ) {}

  async demonstrate(app: HttpApp, url: string): Promise<void> {
    const { logger } = this;
    const origin = this.config.get('corsOrigin');

    const prefixed = await fetch(new URL('api/notes', url));
    logger.info(
      `setGlobalPrefix("api"): GET /api/notes -> ${prefixed.status} ` +
        `${JSON.stringify(await prefixed.json())}`,
    );
    const unprefixed = await fetch(new URL('notes', url));
    logger.info(
      `GET /notes -> ${unprefixed.status} (the unprefixed path is gone)`,
    );

    const created = await postNote(url, 'ship it');
    logger.info(
      `use(RequestTrailMiddleware): POST /api/notes -> ${created.status}, ` +
        `x-handled-by: ${created.headers.get('x-handled-by')}`,
    );
    logger.info(
      `RequestTrail -> ${JSON.stringify(this.trail.entries.slice(-2))}`,
    );

    const rejected = await postNote(url, 7);
    logger.info(
      `POST /api/notes {"text":7} -> ${rejected.status} ` +
        `${JSON.stringify(await rejected.json())}`,
    );

    // Bun.serve answers a method miss with 404, so `enableCors` mounts an
    // explicit OPTIONS per path.
    const allowed = await preflight(url, origin);
    logger.info(
      `enableCors: OPTIONS from ${origin} -> ${allowed.status} ${describeCors(allowed)}`,
    );
    // A denied origin gets no CORS headers, which is what blocks the browser.
    const denied = await preflight(url, 'https://evil.test');
    logger.info(
      `OPTIONS from https://evil.test -> ${denied.status} ${describeCors(denied)}`,
    );

    // One trusted hop, so the last entry wins. Reaching past it takes 2.
    logger.info(
      `set("trust proxy", true): X-Forwarded-For sent -> ${await whoami(url, true)}`,
    );
    logger.info(`no header -> ${await whoami(url, false)}`);

    // Routes and middleware fold into one closure per route at listen().
    try {
      app.setGlobalPrefix('too-late');
    } catch (error) {
      logger.info(
        `setGlobalPrefix() after listen() threw: ${(error as Error).message}`,
      );
    }
  }

  /** The other half of `set('trust proxy')`, which needs its own app to observe. */
  async proxyOff(url: string): Promise<void> {
    this.logger.info(
      `set("trust proxy", false): X-Forwarded-For sent -> ${await whoami(url, true)} ` +
        '(the socket address; the header is ignored)',
    );
  }
}
