import { Logger } from '@dunx/core';
import type { HttpApp } from '@dunx/http';
import { AppConfigService } from '../config.js';
import { RequestLog } from './request-log.js';

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

const whoami = async (url: string, forwarded: boolean): Promise<string> => {
  const response = await fetch(new URL('api/notes/whoami', url), {
    headers: forwarded ? { 'x-forwarded-for': '203.0.113.7, 10.0.0.1' } : {},
  });
  const { ip } = (await response.json()) as { ip: string | undefined };
  return ip ?? '(none)';
};

export class HttpDemo {
  constructor(
    private readonly log: RequestLog,
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
      `use(RequestLoggerMiddleware): POST /api/notes -> ${created.status}, ` +
        `x-handled-by: ${created.headers.get('x-handled-by')}`,
    );
    logger.info(`RequestLog -> ${JSON.stringify(this.log.entries.slice(-2))}`);

    const rejected = await postNote(url, 7);
    logger.info(
      `POST /api/notes {"text":7} -> ${rejected.status} ` +
        `${JSON.stringify(await rejected.json())}`,
    );

    // Bun.serve answers a method miss with 404, so a preflight can never be
    // inferred - enableCors mounts an explicit OPTIONS per path.
    const allowed = await preflight(url, origin);
    logger.info(
      `enableCors: OPTIONS from ${origin} -> ${allowed.status} ${describeCors(allowed)}`,
    );
    // A denied origin gets no CORS headers at all, which is what makes a browser
    // block the response.
    const denied = await preflight(url, 'https://evil.test');
    logger.info(
      `OPTIONS from https://evil.test -> ${denied.status} ${describeCors(denied)}`,
    );

    logger.info(
      `set("trust proxy", true): X-Forwarded-For sent -> ${await whoami(url, true)}`,
    );
    logger.info(`no header -> ${await whoami(url, false)}`);

    // The route table and the middleware chain fold into one closure per route at
    // listen(), so a late call could only ever be a silent no-op.
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
