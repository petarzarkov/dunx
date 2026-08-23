import {
  Controller,
  Get,
  HttpError,
  HttpStatusCode,
  Post,
  type Input,
} from '@dunx/http';
import { EncodableFormat } from '@dunx/infra/images';
import { isConnectionError } from '@dunx/infra/redis';
import { JobPublisher } from '@dunx/infra/queue';
import { z } from 'zod';
import { THUMBNAIL_QUEUE, type RenderResult } from './thumbnail.jobs.js';

const Enqueue = z
  .object({
    width: z.coerce.number().int().min(1).max(1024).default(128),
    format: z.enum(EncodableFormat).default(EncodableFormat.WEBP),
  })
  // `.strict()` after `.meta()` discards the metadata; put `.meta()` last.
  .strict()
  .meta({
    id: 'EnqueueRender',
    description: 'A thumbnail to render off the request',
  });

const enqueue = { body: Enqueue } as const;
const oneJob = { params: z.object({ id: z.string().min(1) }) } as const;

/** The publish side: `QueueModule.forRoot` binds `JobPublisher` and no worker. */
@Controller('jobs')
export class JobsController {
  constructor(private readonly publisher: JobPublisher) {}

  @Post('/thumbnails', enqueue)
  async enqueue(
    input: Input<typeof enqueue>,
  ): Promise<{ id: string; queue: string; state: string }> {
    const job = await this.degrades(() =>
      this.publisher.publish(THUMBNAIL_QUEUE, 'render', input.body),
    );

    return {
      id: job.id ?? '(unassigned)',
      queue: THUMBNAIL_QUEUE,
      state: await job.getState(),
    };
  }

  /** `returnvalue` is whatever the handler returned, so this is how the web
   * process reads a result computed elsewhere. */
  @Get('/thumbnails/:id', oneJob)
  async status(input: Input<typeof oneJob>): Promise<{
    id: string;
    state: string;
    result: RenderResult | null;
    failedReason: string | null;
  }> {
    const job = await this.degrades(() =>
      this.publisher.queue(THUMBNAIL_QUEUE).getJob(input.params.id),
    );
    if (job === undefined) {
      throw new HttpError(
        HttpStatusCode.NOT_FOUND,
        `No job ${input.params.id} on "${THUMBNAIL_QUEUE}"`,
      );
    }

    return {
      id: job.id ?? input.params.id,
      state: await job.getState(),
      result: (job.returnvalue as RenderResult | null) ?? null,
      failedReason: job.failedReason ?? null,
    };
  }

  /**
   * No Redis is a degraded queue, not a broken app. bullmq surfaces the failure
   * through ioredis, so the error shape is not guaranteed; anything unrecognised
   * still becomes a 503.
   */
  private async degrades<T>(run: () => Promise<T>): Promise<T> {
    try {
      return await run();
    } catch (error) {
      if (error instanceof HttpError) throw error;
      const reason = isConnectionError(error)
        ? (error as Error).message
        : `${(error as Error).name}: ${(error as Error).message}`;
      throw new HttpError(
        HttpStatusCode.SERVICE_UNAVAILABLE,
        `Queue unavailable: ${reason}`,
      );
    }
  }
}
