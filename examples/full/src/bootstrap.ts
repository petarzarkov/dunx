import { betterAuthDocument, Auth } from '@dunx/auth';
import { DashboardMiddleware } from '@dunx/dashboard';
import {
  Compression,
  HttpFactory,
  RedisRelay,
  StaticFiles,
  ThrottleGuard,
  type HttpApp,
} from '@dunx/http';
import { OpenApiModule } from '@dunx/openapi';
import { AppModule } from './app.module.js';
import { AppConfigService, RELAY_CHANNEL, validate } from './config.js';
import { RequestTrailMiddleware } from './http/request-trail.js';

/**
 * One app for `bun start`, `bun run tour` and the tests. Everything between
 * `create()` and `listen()` may still shape the server; after `listen()` each of
 * these throws.
 */
export const createApp = async (): Promise<HttpApp> => {
  // Read before there is a container, so this is the one call to `validate`
  // rather than `ConfigService.get`.
  const log = validate(Bun.env).log;

  const app = await HttpFactory.create(
    // `forRootAsync` because `contribute` needs the `Auth` instance, which
    // `AppModule` exports and the graph cannot supply synchronously.
    OpenApiModule.forRootAsync({
      root: AppModule,
      inject: [Auth] as const,
      useFactory: (auth: Auth) => ({
        title: 'dunx full example',
        version: '0.1.0',
        description:
          'Every part of dunx in one service. Generated from the same zod schemas the routes validate against.',
        // better-auth answers `/api/auth/*` itself, so route discovery sees
        // none of it; this merges the library's own schema in.
        contribute: [
          betterAuthDocument(auth, { basePath: '/api/auth', tag: 'Auth' }),
        ],
        /**
         * Every Swagger UI parameter is available; these are a sample.
         * `requestInterceptor` takes the source of an expression, not a
         * function - the page is rendered server-side, so a closure cannot travel.
         */
        ui: {
          title: 'dunx full example - API',
          docExpansion: 'list',
          filter: true,
          tryItOutEnabled: true,
          persistAuthorization: true,
          displayRequestDuration: true,
          operationsSorter: 'alpha',
          tagsSorter: 'alpha',
          syntaxHighlight: { theme: 'nord' },
          requestInterceptor:
            '(req) => { req.headers["x-dunx-example"] = "1"; return req; }',
        },
      }),
    }),
    {
      requestLogging: {
        // Off by default: both cost a `req.clone().text()` on the hot path.
        requestBody: log.requestBody,
        responseBody: log.responseBody,
        // The dashboard polls every five seconds and would bury everything else.
        ignorePrefix: ['/api/_dunx'],
        // `trace` is not set: W3C Trace Context is on by default, and
        // `TraceController` reading it back proves that rather than asserting a
        // flag this file set.
      },
      // Per-route counts and timings, folded into the entry request logging
      // already builds. The dashboard's stats panel reads them.
      metrics: true,
      websocket: { idleTimeout: 30 },
      // Multi-node websocket fan-out on `Bun.RedisClient`. No url, so it
      // resolves $VALKEY_URL, $REDIS_URL, then localhost. With no Redis running
      // it degrades to single-process behaviour and still boots.
      relay: new RedisRelay({ connectionTimeout: 500 }),
      relayChannel: RELAY_CHANNEL,
    },
  );

  // `listen(port)` rather than a `create()` option, so `PORT` goes through the
  // same validation as everything else.
  const config = app.get(AppConfigService);
  app.setGlobalPrefix('api');
  // First, ahead of everything. Its `authorize` answers 404 to a stranger; a
  // guard running earlier would answer 401 and confirm the mount exists.
  app.use(DashboardMiddleware);
  app.use(Compression);
  // Before the rate limit: twenty hashed bundles must not spend a request budget.
  app.use(StaticFiles);
  app.use(RequestTrailMiddleware);
  // After anything that establishes the caller, since that decides the subject.
  app.use(ThrottleGuard);
  app.set('trust proxy', true);
  app.enableCors({
    origin: config.get('corsOrigin'),
    credentials: true,
    exposedHeaders: ['x-handled-by'],
    maxAge: 600,
  });
  return app;
};
