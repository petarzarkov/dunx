import { Logger } from '@dunx/core';
import { EncodableFormat } from '@dunx/infra/images';
import { JobPublisher } from '@dunx/infra/queue';
import { isConnectionError } from '@dunx/infra/redis';
import { THUMBNAIL_QUEUE, type RenderResult } from './thumbnail.jobs.js';

/** How long to wait for a forked worker to answer before giving up on it. */
const SETTLE_MS = 8_000;
const POLL_MS = 150;

/**
 * The queue, end to end: publish here, let bullmq fork the handler into another
 * process, read back what it returned. Skips when the broker is absent.
 */
export class JobsDemo {
  constructor(
    private readonly logger: Logger,
    private readonly publisher: JobPublisher,
  ) {}

  async demonstrate(): Promise<void> {
    try {
      await this.publishAndWait();
    } catch (error) {
      // Only a broker failure is a skip. Anything else is a real defect, and
      // "no broker" is how it would go unnoticed: the tour exits 0 either way.
      if (!isConnectionError(error)) throw error;
      const reason = error instanceof Error ? error.message : String(error);
      this.logger.info(`no broker reachable - skipping the queue: ${reason}`);
    }
  }

  private async publishAndWait(): Promise<void> {
    const queue = this.publisher.queue(THUMBNAIL_QUEUE);
    const published = await this.publisher.publish(THUMBNAIL_QUEUE, 'render', {
      width: 96,
      format: EncodableFormat.WEBP,
    });
    const id = published.id ?? '(unassigned)';

    this.logger.info(
      `published render to ${THUMBNAIL_QUEUE} as job ${id} - this container holds ` +
        'the publish side, and bullmq forks jobs.processor.ts to run the handler',
    );

    // Re-fetched rather than polled on the handle publish returned: `returnvalue`
    // is filled at load time, so the original handle never sees it.
    const deadline = Date.now() + SETTLE_MS;
    let job;
    let state;
    do {
      job = await queue.getJob(id);
      state = job === undefined ? 'missing' : await job.getState();
      if (state !== 'waiting' && state !== 'active' && state !== 'delayed')
        break;
      await Bun.sleep(POLL_MS);
    } while (Date.now() < deadline);

    if (state !== 'completed') {
      this.logger.info(
        `job ${id} is ${state} after ${SETTLE_MS} ms - not waiting longer`,
      );
      return;
    }

    const result = job?.returnvalue as RenderResult | null;
    this.logger.info(
      `job ${id} completed in a process this one never started: ${
        result === null || result === undefined
          ? 'no return value'
          : `${result.width}x${result.height}, ${result.bytes} bytes`
      }`,
    );
  }
}
