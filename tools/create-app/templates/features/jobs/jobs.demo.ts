import { Logger } from '@dunx/core';
import { EncodableFormat } from '@dunx/infra/images';
import { JobEvents, JobPublisher } from '@dunx/infra/queue';
import { isConnectionError } from '@dunx/infra/redis';
import {
  AUDIT_QUEUE,
  THUMBNAIL_QUEUE,
  type RenderResult,
} from './thumbnail.jobs.js';

/** How long to wait for a forked worker to answer before giving up on it. */
const SETTLE_MS = 8_000;

/** The queue, end to end: publish here, let bullmq fork the handler elsewhere,
 * read back what it returned. Skips with no broker. */
export class JobsDemo {
  constructor(
    private readonly logger: Logger,
    private readonly publisher: JobPublisher,
    private readonly events: JobEvents,
  ) {}

  async demonstrate(): Promise<void> {
    try {
      await this.publishAndWait();
    } catch (error) {
      // Only a broker failure is a skip: the tour exits 0 either way.
      if (!isConnectionError(error)) throw error;
      const reason = error instanceof Error ? error.message : String(error);
      this.logger.info(`no broker reachable - skipping the queue: ${reason}`);
    }
  }

  private async publishAndWait(): Promise<void> {
    const published = await this.publisher.publish(THUMBNAIL_QUEUE, 'render', {
      width: 96,
      format: EncodableFormat.WEBP,
    });
    const id = published.id ?? '(unassigned)';

    this.logger.info(
      `published render to ${THUMBNAIL_QUEUE} as job ${id} - this container holds ` +
        'the publish side, and bullmq forks jobs.processor.ts to run the handler',
    );

    // Rejects on a failed job and on the ttl, both outcomes rather than
    // defects. docs/guide/15-queues.md, "Waiting for a job to finish".
    let result: RenderResult;
    try {
      result = (await published.waitUntilFinished(
        this.events.events(THUMBNAIL_QUEUE),
        SETTLE_MS,
      )) as RenderResult;
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      this.logger.info(`job ${id} did not finish: ${reason}`);
      return;
    }

    this.logger.info(
      `job ${id} completed in a process this one never started: ` +
        `${result.width}x${result.height}, ${result.bytes} bytes`,
    );

    // Foreground, so this handler runs here: the stats section reads both.
    const audit = await this.publisher.publish(AUDIT_QUEUE, 'record', result);
    // Wrapped for the reason the render above is: the ttl rejects, and a slow
    // audit took the whole tour down rather than narrating that it was slow.
    try {
      await audit.waitUntilFinished(this.events.events(AUDIT_QUEUE), SETTLE_MS);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      this.logger.info(
        `audit ${audit.id ?? '(unassigned)'} did not finish: ${reason}`,
      );
      return;
    }
    this.logger.info(
      `audit ${audit.id ?? '(unassigned)'} ran in this process, so its handler ` +
        'duration is one this container can report',
    );
  }
}
