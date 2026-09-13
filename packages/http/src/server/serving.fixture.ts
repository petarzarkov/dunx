import type { HttpApp } from './factory.js';

/**
 * Boot an app on an ephemeral port, run against it, and shut it down whatever
 * happens.
 *
 * Eleven suites in this directory had written this `try`/`finally` themselves, and
 * a `listen(0)` that is not closed on a failing assertion leaks a server into the
 * rest of the run. Each caller still declares its own `withApp` over this, because
 * what differs between them is only how the app is built: one configures it after
 * `create`, one passes middleware, several pass options.
 */
export const serving = async (
  create: () => Promise<HttpApp>,
  run: (app: HttpApp, url: string) => Promise<void>,
): Promise<void> => {
  const app = await create();
  const url = await app.listen(0);
  try {
    await run(app, url);
  } finally {
    await app.shutdown();
  }
};
