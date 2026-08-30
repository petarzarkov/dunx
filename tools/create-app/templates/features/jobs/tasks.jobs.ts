import { Logger } from '@dunx/core';
import { JobHandler } from '@dunx/infra/queue';
import type { Job } from 'bullmq';

export const TASKS_QUEUE = 'tasks';

export interface EchoRequest {
  readonly note: string;
}

export interface FlakyRequest {
  /** Distinguishes one test's job from another's, since the count is per token. */
  readonly token: string;
  readonly failTimes: number;
}

/**
 * Handlers on a queue with no `background` marker, so they run in this process.
 * `ThumbnailJobs` covers the forked path; a queue is sandboxed when **any** of
 * its handlers asks for it, so the two cannot share one.
 *
 * They exist to be observed: `jobs.characterize.test.ts` pins retry, delay and
 * result behaviour through the routes below, which is what a second queue backend
 * has to reproduce.
 */
export class TaskJobs {
  /** Counted per token rather than read off the job, so the assertion does not
   * depend on when a backend increments its attempt counter. */
  static readonly attempts = new Map<string, number>();

  constructor(private readonly logger: Logger) {}

  @JobHandler({ queue: TASKS_QUEUE, name: 'echo' })
  echo(job: Job<EchoRequest>): { note: string; at: number } {
    return { note: job.data.note, at: Date.now() };
  }

  @JobHandler({ queue: TASKS_QUEUE, name: 'flaky' })
  flaky(job: Job<FlakyRequest>): { attempts: number } {
    const { token, failTimes } = job.data;
    const attempt = (TaskJobs.attempts.get(token) ?? 0) + 1;
    TaskJobs.attempts.set(token, attempt);
    if (attempt <= failTimes) {
      this.logger.debug(`flaky ${token} failing attempt ${attempt}`);
      throw new Error(`attempt ${attempt} failed on purpose`);
    }
    return { attempts: attempt };
  }
}
