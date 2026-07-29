import type { ModuleRef } from '@dunx/core';
import { HttpFactory, type HttpApp } from '@dunx/http';
import { OpenApiModule } from '@dunx/openapi';
import { AppModule } from './app.module.js';
import { Config } from './config.js';
import { DocsDemo } from './docs/docs.demo.js';
import { AuthGuard } from './guards/auth.guard.js';
import { GuardsDemo } from './guards/guards.demo.js';
import { GuardsModule } from './guards/guards.module.js';
import { HttpDemo } from './http/http.demo.js';
import { RequestLoggerMiddleware } from './http/request-log.js';
import { Logger } from './logger.js';
import { NotesModule } from './notes/notes.module.js';
import { Tour } from './tour/tour.service.js';

/**
 * `create()` boots the container and discovers routes and gateways; `listen()` is
 * what builds the `Bun.serve` route table — so everything between the two still
 * gets to shape it, and after `listen()` every one of these throws.
 */
const configure = async (
  root: ModuleRef,
  trustProxy: boolean,
): Promise<HttpApp> => {
  const app = await HttpFactory.create(root, {
    // Port 0 by default so concurrent runs never collide.
    port: Number(process.env['PORT'] ?? 0),
    websocket: { idleTimeout: 30 },
  });
  app.setGlobalPrefix('api');
  app.use(RequestLoggerMiddleware);
  app.set('trust proxy', trustProxy);
  app.enableCors({
    origin: app.get(Config).corsOrigin,
    credentials: true,
    exposedHeaders: ['x-handled-by'],
    maxAge: 600,
  });
  return app;
};

/** `set('trust proxy')` cannot be changed after listen(), so the off case is its own app. */
const withoutTrustedProxy = async (logger: Logger): Promise<void> => {
  logger.group('@dunx/http — a second app, trust proxy off');
  const app = await configure(NotesModule, false);
  const url = await app.listen();
  await app.get(HttpDemo).proxyOff(url);
  await app.shutdown();
};

/**
 * A third app, because a *global* auth guard would challenge every route of the
 * tour above. `HttpOptions.middleware` is the outermost layer; the controller's
 * `@UseGuards` sit inside it, and its methods' inside those.
 */
const withGuards = async (logger: Logger): Promise<void> => {
  logger.group('@dunx/http — @Public, @Roles and @UseGuards');
  // Documented too, so the same metadata can be seen enforced at runtime and
  // described in the document. The docs routes are @Public(), which is the only
  // reason a global AuthGuard lets them through.
  const app = await HttpFactory.create(
    OpenApiModule.forRoot({
      title: 'dunx playground — guarded',
      version: '0.1.0',
      root: GuardsModule,
    }),
    { port: 0, middleware: [AuthGuard] },
  );
  app.setGlobalPrefix('api');
  const url = await app.listen();
  await app.get(GuardsDemo).demonstrate(url);
  logger.group('@dunx/openapi — security, from the guards’ own metadata');
  await app.get(DocsDemo).guarded(url);
  await app.shutdown();
};

async function bootstrap(): Promise<void> {
  // OpenApiModule wraps the root it documents, so `create()` is handed one module
  // ref as always and the document's own routes are discovered with the rest.
  const app = await configure(
    OpenApiModule.forRoot({
      title: 'dunx playground',
      version: '0.1.0',
      description:
        'Generated from the same zod schemas the routes validate against.',
      root: AppModule,
    }),
    true,
  );
  app.enableShutdownHooks();

  const url = await app.listen();
  const logger = app.get(Logger);
  logger.info(`listening on ${url}`);

  await app.get(Tour).run(app, url);

  if (process.env['DUNX_HOLD']) {
    logger.info('holding — send SIGTERM to close');
    await app.closed;
    return;
  }

  await app.shutdown();
  await withoutTrustedProxy(logger);
  await withGuards(logger);
}

bootstrap().catch((error: unknown) => {
  console.error('[dunx] failed to start', error);
  process.exit(1);
});
