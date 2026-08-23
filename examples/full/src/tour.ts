import { Logger } from '@dunx/core';
import { createApp } from './bootstrap.js';
import { Tour } from './tour/tour.service.js';

/** The scripted walkthrough CI runs: boot the app `bun start` serves, narrate
 * every package, shut down, exit 0. */
async function run(): Promise<void> {
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
    // not. Against an unreachable broker, bullmq's Bun adapter cannot cancel its
    // pending reconnect and holds the event loop open. Upstream, not fixable here.
    process.exit(0);
  })
  .catch((error: unknown) => {
    console.error('[full] tour failed', error);
    process.exit(1);
  });
