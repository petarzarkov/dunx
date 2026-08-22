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
 * One app, built the same way for `bun start`, `bun run tour` and the tests -
 * so what the tests exercise is what actually serves.
 *
 * `create()` boots the container and discovers routes and gateways; `listen()` is
 * what builds the `Bun.serve` route table. Everything between the two still gets
 * to shape it, and after `listen()` every one of these throws.
 *
 * `OpenApiModule` wraps the root it documents, so `create()` is handed one module
 * ref as always and the document's own routes are discovered with the rest.
 */
export const createApp = async (): Promise<HttpApp> => {
  // `requestLogging` is read before there is a container, so this is the one place
  // that calls `validate` rather than `ConfigService.get`. Same function and the
  // same defaults, one extra parse at boot.
  const log = validate(Bun.env).log;

  const app = await HttpFactory.create(
    // `forRootAsync`, because `contribute` needs the `Auth` instance and there is
    // no container yet while the module graph is being described. `Auth` reaches
    // this factory because `AppModule` exports it.
    OpenApiModule.forRootAsync({
      root: AppModule,
      inject: [Auth] as const,
      useFactory: (auth: Auth) => ({
        title: 'dunx full example',
        version: '0.1.0',
        description:
          'Every part of dunx in one service. Generated from the same zod schemas the routes validate against.',
        // Better Auth answers `/api/auth/*` from its own handler, so route
        // discovery sees none of it. This asks the library for its schema and
        // merges it in. `tag` because the default is `auth` and every other tag in
        // this document is a controller name.
        contribute: [
          betterAuthDocument(auth, { basePath: '/api/auth', tag: 'Auth' }),
        ],
        /**
         * Every Swagger UI parameter is available here. These are the ones worth
         * demonstrating rather than a full dump: the two dunx owns (`favicon`,
         * `title`), a few display settings, and one of the seven that are functions.
         *
         * `requestInterceptor` takes the **source** of an expression, not a function:
         * the page is rendered on the server and a closure has nowhere to travel. It
         * is written into the boot script verbatim.
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
      // `@dunx/http` writes the request entry itself - one line carrying the
      // request and its response - and this is the whole of what an app tunes.
      // Nothing here writes a second one.
      requestLogging: {
        // Off by default in the framework, on here: this is a walkthrough, and
        // both cost a `req.clone().text()` on the hot path.
        requestBody: log.requestBody,
        responseBody: log.responseBody,
        // The dashboard polls four endpoints every five seconds and bull-board
        // pulls a dozen assets, so logging its subtree buries everything else the
        // service does. It is an operations page looking at the logs, not a thing
        // the logs are about.
        ignorePrefix: ['/api/_dunx'],
      },
      websocket: { idleTimeout: 30 },
      // Multi-node websocket fan-out, on `Bun.RedisClient` and therefore on no
      // dependency at all. No url, so it resolves the same chain `RedisModule`
      // does - $VALKEY_URL, $REDIS_URL, then localhost. The relay cannot read the
      // validated config for the same reason the port cannot: the container does
      // not exist yet when these options are read.
      //
      // With no Redis running this degrades to exactly the single-process
      // behaviour, logs one warning, and the app still boots.
      relay: new RedisRelay({ connectionTimeout: 500 }),
      relayChannel: RELAY_CHANNEL,
    },
  );

  // The port is not passed to `create()`: the container does not exist yet when
  // its options are read. `listen(port)` overrides, which is what lets `PORT` go
  // through the same validation as every other setting.
  const config = app.get(AppConfigService);
  app.setGlobalPrefix('api');
  // The dashboard goes **first**, ahead of everything else the app registers.
  // Its `authorize` answers 404 to a caller it does not recognise, and a guard
  // running before it would answer 401 instead - which tells a prober the mount
  // exists. That contract only holds because `authorize` takes the raw Request
  // and asks nothing of an earlier middleware.
  app.use(DashboardMiddleware);
  // Outside the assets mount and every route, so one registration covers both.
  // Inside the dashboard, which answers its own requests and never calls next():
  // an ops page is not worth the CPU. Request logging is installed by the
  // framework ahead of all of these, so the status it records is the real one.
  app.use(Compression);
  // Static assets before the rate limit and outside the global prefix: a page
  // pulling twenty hashed bundles must not spend a caller's request budget.
  app.use(StaticFiles);
  app.use(RequestTrailMiddleware);
  // The limit goes after anything that establishes who is calling, because the
  // subject it counts by is what that decides. This app has no global session
  // guard, so `x-api-key` or the address is as far as it gets.
  app.use(ThrottleGuard);
  // Global middleware, so it also runs in front of the unmatched-path fallback -
  app.set('trust proxy', true);
  app.enableCors({
    origin: config.get('corsOrigin'),
    credentials: true,
    exposedHeaders: ['x-handled-by'],
    maxAge: 600,
  });
  return app;
};
