import { HttpFactory, type HttpApp } from '@dunx/http';
import { AppModule } from './app.module.js';
import { RequestLog, RequestLoggerMiddleware } from './request-log.js';

const ORIGIN = 'https://example.com';
const say = (message: string): void => console.log(`[dunx] ${message}`);

// Port 0 so concurrent runs never collide. Every hook below has to run before
// listen(), which is what builds the route table.
const boot = async (trustProxy: boolean): Promise<[HttpApp, string]> => {
  const app = await HttpFactory.create(AppModule);
  app.setGlobalPrefix('api');
  app.use(RequestLoggerMiddleware);
  app.set('trust proxy', trustProxy);
  app.enableCors({
    origin: ORIGIN,
    credentials: true,
    exposedHeaders: ['x-handled-by'],
    maxAge: 600,
  });
  return [app, await app.listen(0)];
};

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

const whoami = async (url: string, forwarded: boolean): Promise<string> => {
  const response = await fetch(new URL('api/notes/whoami', url), {
    headers: forwarded ? { 'x-forwarded-for': '203.0.113.7, 10.0.0.1' } : {},
  });
  const { ip } = (await response.json()) as { ip: string | undefined };
  return ip ?? '(none)';
};

const [app, url] = await boot(true);
say(`listening on ${url}`);

say('--- setGlobalPrefix("api")');
const prefixed = await fetch(new URL('api/notes', url));
say(
  `GET /api/notes -> ${prefixed.status} ${JSON.stringify(await prefixed.json())}`,
);
const unprefixed = await fetch(new URL('notes', url));
say(`GET /notes    -> ${unprefixed.status} (the unprefixed path is gone)`);

say('--- use(RequestLoggerMiddleware)');
const created = await fetch(new URL('api/notes', url), {
  method: 'POST',
  body: JSON.stringify({ text: 'ship it' }),
});
say(
  `POST /api/notes -> ${created.status}, x-handled-by: ${created.headers.get('x-handled-by')}`,
);
say(`RequestLog -> ${JSON.stringify(app.get(RequestLog).entries)}`);

say(`--- enableCors({ origin: "${ORIGIN}", credentials: true })`);
const allowed = await preflight(url, ORIGIN);
say(`OPTIONS from ${ORIGIN} -> ${allowed.status} ${describeCors(allowed)}`);
const denied = await preflight(url, 'https://evil.test');
say(
  `OPTIONS from https://evil.test -> ${denied.status} ${describeCors(denied)}`,
);

say('--- set("trust proxy", true)');
say(`X-Forwarded-For sent -> ${await whoami(url, true)}`);
say(`no header            -> ${await whoami(url, false)}`);

say('--- a hook called after listen()');
try {
  app.setGlobalPrefix('too-late');
} catch (error) {
  say(`setGlobalPrefix() threw: ${(error as Error).message}`);
}

await app.shutdown();
say(`app closed after ${app.get(RequestLog).entries.length} logged requests`);

const [plain, plainUrl] = await boot(false);
say('--- the same app, trust proxy off');
say(
  `X-Forwarded-For sent -> ${await whoami(plainUrl, true)} (the socket; header ignored)`,
);
await plain.shutdown();
say('second app closed');
