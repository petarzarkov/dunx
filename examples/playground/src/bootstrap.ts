import { HttpFactory, type HttpApp } from '@dunx/http';
import { OpenApiModule } from '@dunx/openapi';
import { AppModule } from './app.module.js';
import { AppConfigService } from './config.js';
import { RequestLoggerMiddleware } from './http/request-log.js';

/**
 * One app, built the same way for `bun start`, `bun run tour` and the tests —
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
      title: 'dunx playground',
      version: '0.1.0',
      description:
        'Every part of dunx in one service. Generated from the same zod schemas the routes validate against.',
      root: AppModule,
    }),
    { websocket: { idleTimeout: 30 } },
  );

  // The port is not passed to `create()`: the container does not exist yet when
  // its options are read. `listen(port)` overrides, which is what lets `PORT` go
  // through the same validation as every other setting.
  const config = app.get(AppConfigService);
  app.setGlobalPrefix('api');
  app.use(RequestLoggerMiddleware);
  app.set('trust proxy', true);
  app.enableCors({
    origin: config.get('corsOrigin'),
    credentials: true,
    exposedHeaders: ['x-handled-by'],
    maxAge: 600,
  });
  return app;
};
