import { Logger } from '@dunx/core';
import { createApp } from './bootstrap.js';
import { Tour } from './tour/tour.service.js';

/**
 * The scripted walkthrough: boot the same app `bun start` serves, narrate every
 * package, shut down, exit 0. This is what CI runs — it is the end-to-end check
 * that the whole DI graph builds and every part works.
 */
async function run(): Promise<void> {
  const app = await createApp();
  // Port 0 so a tour never collides with a `bun start` already holding 3000.
  const url = await app.listen(0);
  const logger = app.get(Logger);
  logger.info(`tour listening on ${url}`);

  await app.get(Tour).run(app, url);
  await app.shutdown();
}

run().catch((error: unknown) => {
  console.error('[playground] tour failed', error);
  process.exit(1);
});
