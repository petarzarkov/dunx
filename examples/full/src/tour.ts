import { Logger } from '@dunx/core';
import { createApp } from './bootstrap.js';
import { Tour } from './tour/tour.service.js';

/**
 * The scripted walkthrough: boot the same app `bun start` serves, narrate every
 * package, shut down, exit 0. This is what CI runs - it is the end-to-end check
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

run()
  .then(() => {
    /**
     * Shutdown has completed - every provider drained and every socket dunx owns
     * was closed. The explicit exit is for the one it does not own.
     *
     * Against an **unreachable** broker, bullmq's Bun adapter cannot cancel its own
     * pending reconnect, so a client survives `disconnect()` and holds the event
     * loop open forever. That is leak B in
     * docs/roadmap/queue-shutdown-sigterm.md - measured, upstream, and not fixable
     * from here. It is why a real deployment sets a grace period short enough that
     * `SIGKILL` arrives promptly (guide 19-deployment.md); this is that grace period.
     *
     * Without it, CI's `tour` step hangs forever rather than failing, because the
     * tour has narrated everything correctly and simply will not exit.
     */
    process.exit(0);
  })
  .catch((error: unknown) => {
    console.error('[full] tour failed', error);
    process.exit(1);
  });
