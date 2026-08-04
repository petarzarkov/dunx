import { HttpFactory, RedisRelay, type HttpApp } from '@dunx/http';
import { OpenApiModule } from '@dunx/openapi';
import { AppModule } from './app.module.js';
import { AppConfigService, RELAY_CHANNEL } from './config.js';
import { QueueDashboardMiddleware } from '@dunx/queue-dashboard';
import { RequestLoggerMiddleware } from './http/request-log.js';

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
  const app = await HttpFactory.create(
    OpenApiModule.forRoot({
      title: 'dunx full example',
      version: '0.1.0',
      description:
        'Every part of dunx in one service. Generated from the same zod schemas the routes validate against.',
      root: AppModule,
    }),
    {
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
  app.use(RequestLoggerMiddleware);
  // Global middleware, so it also runs in front of the unmatched-path fallback -
  // which is where the board's paths land, since no controller declares them.
  app.use(QueueDashboardMiddleware);
  app.set('trust proxy', true);
  app.enableCors({
    origin: config.get('corsOrigin'),
    credentials: true,
    exposedHeaders: ['x-handled-by'],
    maxAge: 600,
  });
  return app;
};
