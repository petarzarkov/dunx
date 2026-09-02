import { Logger } from '@dunx/core';
import { createApp } from './main.js';
import { Tour } from './tour/tour.service.js';

/** The scripted walkthrough CI runs: boot the app `bun start` serves, narrate
 * every package, shut down, exit 0. */
async function run(): Promise<void> {
  // `TRUST_PROXY` defaults to false, which is the right default for an app that
  // may have nothing stripping `x-forwarded-for`. The tour demonstrates what the
  // setting does, so it turns it on for itself rather than shipping an unsafe
  // default for every scaffolded app. `??=`, so an env that set it still wins.
  process.env['TRUST_PROXY'] ??= 'true';

  const app = await createApp();
  const url = await app.listen(0);
  const logger = app.get(Logger);
  logger.info(`tour listening on ${url}`);

  await app.get(Tour).run(app, url);
  await app.shutdown();
}

run()
  .then(() => {
    // Every socket dunx owns is closed by now; the exit is for the one it does
    // not. Against an unreachable broker a bullmq `Worker` never resolves
    // `close()` and holds the loop open, on Node as well as Bun - filed as
    // taskforcesh/bullmq#4656. Upstream, not fixable here.
    process.exit(0);
  })
  .catch((error: unknown) => {
    console.error('[full] tour failed', error);
    process.exit(1);
  });
