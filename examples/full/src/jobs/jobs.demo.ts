import { Logger } from '@dunx/core';
import { EncodableFormat } from '@dunx/infra/images';
import { JobPublisher } from '@dunx/infra/queue';
import { isConnectionError } from '@dunx/infra/redis';
import { THUMBNAIL_QUEUE, type RenderResult } from './thumbnail.jobs.js';

/** How long to wait for a forked worker to answer before giving up on it. */
const SETTLE_MS = 8_000;
const POLL_MS = 150;

/**
 * The queue, end to end: publish from this process, let bullmq fork the handler
 * into another one, and read back what it returned. Skips rather than fails when
 * the broker is absent, the way every other service-backed step here does.
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
      // Broadly, the way `JobsController.degrades` does: bullmq surfaces a
      // broker failure through its own client, so what arrives is Bun's
      // `RedisError` rather than the one `isConnectionError` knows.
      const reason = isConnectionError(error)
        ? 'nothing answering'
        : (error as Error).message;
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
    let job = await queue.getJob(id);
    let state = job === undefined ? 'missing' : await job.getState();
    while (
      (state === 'waiting' || state === 'active' || state === 'delayed') &&
      Date.now() < deadline
    ) {
      await Bun.sleep(POLL_MS);
      job = await queue.getJob(id);
      state = job === undefined ? 'missing' : await job.getState();
    }

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
