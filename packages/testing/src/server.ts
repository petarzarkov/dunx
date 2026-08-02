import { HttpFactory, type HttpApp, type HttpOptions } from '@dunx/http';
import { appOptions, testRoot, type TestAppOptions } from './app.js';
import { testClient, type TestClient } from './client.js';

export interface TestServerOptions
  extends TestAppOptions, Omit<HttpOptions, 'port' | 'overrides'> {
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

/**
 * A **real** `Bun.serve` on port 0, with the same override semantics as
 * {@link createTestApp}. Nothing is faked: `Bun.serve` binds in about a
 * millisecond, and a fake would only be able to prove the parts of the request
 * path dunx wrote rather than the parts Bun owns - routing, params, method
 * dispatch, upgrades.
 *
 * ```ts
 * const server = await createTestServer({ modules: [ApiModule], prefix: 'api' });
 * const { status, body } = await server.json('api/users');
 * await server.close();
 * ```
 *
 * Request logging is **off** unless asked for: it is on by default in production
 * for good reasons, none of which apply to a suite that would print one JSON line
 * per assertion.
 */
export const createTestServer = async (
  options: TestServerOptions,
): Promise<TestServer> => {
  const { modules, overrides, prefix, requestLogging, ...http } = options;

  const app = await HttpFactory.create(testRoot(modules), {
    ...http,
    ...appOptions(overrides),
    requestLogging: requestLogging ?? false,
    port: 0,
  });
  if (prefix !== undefined) app.setGlobalPrefix(prefix);

  return {
    ...testClient(await app.listen()),
    app,
    close: () => app.shutdown(),
  };
};
