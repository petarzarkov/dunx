import {
  collectModules,
  readControllers,
  type Ctor,
  type ResolvedModule,
} from '@dunx/core';
import {
  HttpFactory,
  HttpOptionsProvider,
  type HttpApp,
  type HttpOptions,
  type Middleware,
} from '@dunx/http';
import { discoverRoutes } from '@dunx/http/internal';
import { appOptions, testRoot, type TestAppOptions } from './app.js';
import { testClient, type TestClient } from './client.js';

export interface TestServerOptions
  extends
    TestAppOptions,
    Omit<HttpOptions, 'port' | 'gatewayPort' | 'overrides'> {
  /**
   * `setGlobalPrefix`, applied before `listen()` so the client's URLs carry it.
   *
   * Explicitly `| undefined`, unlike the rest of the options: a suite that runs
   * the same fixture prefixed and unprefixed passes a variable here, and under
   * `exactOptionalPropertyTypes` that is otherwise a conditional spread. "No
   * prefix" and "absent" mean the same thing, so nothing is lost by allowing it.
   */
  readonly prefix?: string | undefined;
}

export interface TestServer extends TestClient {
  readonly app: HttpApp;
  /** `app.shutdown()` - stops the server, then tears the container down. */
  close(): Promise<void>;
}

const middlewareShaped = (ctor: Ctor<unknown>): boolean =>
  typeof (ctor.prototype as { handle?: unknown } | undefined)?.handle ===
  'function';

/** Every class provider in the graph that implements `Middleware`. */
const declaredMiddleware = (
  modules: readonly ResolvedModule[],
): readonly Ctor<unknown>[] => {
  const found: Ctor<unknown>[] = [];
  for (const module of modules) {
    for (const entry of module.options.providers ?? []) {
      const ctor =
        typeof entry === 'function'
          ? entry
          : entry.provider.kind === 'class'
            ? entry.provider.ctor
            : undefined;
      if (ctor !== undefined && middlewareShaped(ctor)) found.push(ctor);
    }
  }
  return found;
};

/**
 * The guards `@UseGuards` already puts in the route table. They are not global, so
 * omitting `middleware` costs them nothing and warning about them would be noise.
 */
const scopedGuards = (
  app: HttpApp,
  modules: readonly ResolvedModule[],
): ReadonlySet<Ctor<Middleware>> => {
  const applied = new Set<Ctor<Middleware>>();
  for (const module of modules) {
    for (const controller of readControllers(module)) {
      for (const route of discoverRoutes(app.get(controller) as object)) {
        for (const guard of route.guards ?? []) applied.add(guard);
      }
    }
  }
  return applied;
};

/**
 * The one silent way this harness can lie: `middleware` and `onError` default
 * away, so a suite that forgets them boots a server with no global guards and the
 * default error mapper, which still answers 200 where the application answers 401.
 *
 * So a `Middleware` implementation in the graph, not attached by `@UseGuards`, and
 * reaching the chain from neither the argument nor an `HttpOptionsProvider` is
 * worth one line on `console.warn` - `console`, not the bound `Logger`, so a suite
 * asserting on a `RecordingLogger` sees nothing the application never wrote.
 *
 * `mapperIsDefault` is passed because `onError` resolves from the same two places.
 */
const warnAboutGlobals = (
  app: HttpApp,
  modules: readonly ResolvedModule[],
  mapperIsDefault: boolean,
): void => {
  const declared = declaredMiddleware(modules);
  if (declared.length === 0) return;
  const scoped = scopedGuards(app, modules);
  const orphaned = declared.filter(
    (ctor) => !scoped.has(ctor as Ctor<Middleware>),
  );
  if (orphaned.length === 0) return;

  console.warn(
    `createTestServer: ${orphaned.map((ctor) => ctor.name).join(', ')} ` +
      'implement Middleware and are in the graph under test, but no `middleware` ' +
      'was supplied and no HttpOptionsProvider bound any. If they are global in ' +
      'main.ts then this fixture is not the application: no global guard runs' +
      (mapperIsDefault ? ' and `onError` is the default mapper' : '') +
      '. Bind the same HttpOptionsProvider the application binds, or pass ' +
      '`middleware: []` to say the omission is deliberate.',
  );
};

/**
 * A real `Bun.serve` on port 0, with the same override semantics as
 * {@link createTestApp}. `Bun.serve` binds in about a millisecond, and a fake
 * could only prove the parts of the request path dunx wrote rather than the parts
 * Bun owns - routing, params, method dispatch, upgrades.
 *
 * ```ts
 * const server = await createTestServer({ modules: [ApiModule], prefix: 'api' });
 * const { status, body } = await server.json('api/users');
 * await server.close();
 * ```
 *
 * Request logging and boot logging are off unless asked for, since a suite would
 * otherwise print one JSON line per assertion and one route table per file.
 *
 * An `HttpOptions` field not passed is absent, not inherited from production.
 * `middleware` and `onError` change what the application does, so pass the same
 * object `main.ts` passes. `middleware: []` says the omission is deliberate.
 */
export const createTestServer = async (
  options: TestServerOptions,
): Promise<TestServer> => {
  const { modules, overrides, prefix, requestLogging, bootLogging, ...http } =
    options;

  const root = testRoot(modules);
  const app = await HttpFactory.create(root, {
    ...http,
    ...appOptions(overrides),
    requestLogging: requestLogging ?? false,
    // Off for the same reason: a suite that boots a server per file does not want a
    // route table per file. A suite asserting on the table asks for it.
    bootLogging: bootLogging ?? false,
    port: 0,
    // Forced like `port`: an `HttpOptionsProvider` answering a fixed gateway port
    // from config would otherwise have every test server bind the same one, and
    // two files under `bun test --parallel` collide on it. `0` splits the ports
    // when a gateway exists and is ignored without one.
    gatewayPort: 0,
  });
  // The argument is not the only source since 3.1.0: `resolveHttpOptions` runs
  // inside `HttpFactory.create` and reconciles it with the bound
  // `HttpOptionsProvider`, so reading the argument alone warned at applications
  // that had done the better thing.
  const settings = app.get(HttpOptionsProvider);
  if (http.middleware === undefined && settings.middleware.length === 0)
    warnAboutGlobals(
      app,
      collectModules(root),
      // `in`, not `??`: `resolveHttpOptions` merges by `Object.keys(given)`, so an
      // explicit `onError: undefined` is a caller saying "no filter" and the
      // default mapper is what runs.
      ('onError' in http ? http.onError : settings.onError) === undefined,
    );
  if (prefix !== undefined) app.setGlobalPrefix(prefix);

  return {
    ...testClient(await app.listen()),
    app,
    close: () => app.shutdown(),
  };
};
