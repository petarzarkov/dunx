import { Logger } from '@dunx/core';
import { EncodableFormat, ImageFit } from '@dunx/infra/images';
import { JobHandler } from '@dunx/infra/queue';
import type { Job } from 'bullmq';
import { Thumbnails } from '../pictures/thumbnails.service.js';

export const THUMBNAIL_QUEUE = 'thumbnails';

export interface RenderRequest {
  readonly width: number;
  readonly format: EncodableFormat;
}

export interface RenderResult {
  readonly width: number;
  readonly height: number;
  readonly bytes: number;
}

/**
 * A job handler is a method with a decorator and nothing else - no registry, no
 * class decorator, no queue token. `WorkerFactory` finds it by walking the
 * prototypes of the classes already in `providers`, the same marker-plus-scan the
 * route and gateway discovery use.
 *
 * It injects like anything else, which is the point: the same `Thumbnails` service
 * the HTTP routes use does the work here, with no second wiring.
 */
export class ThumbnailJobs {
  constructor(
    private readonly thumbnails: Thumbnails,
    private readonly logger: Logger,
  ) {}

  @JobHandler({ queue: THUMBNAIL_QUEUE, name: 'render' })
  async render(job: Job<RenderRequest>): Promise<RenderResult> {
    const encoded = await this.thumbnails.render({
      width: job.data.width,
      fit: ImageFit.INSIDE,
      format: job.data.format,
    });

    const result: RenderResult = {
      width: encoded.width,
      height: encoded.height,
      bytes: encoded.bytes.byteLength,
    };
    // Written by the worker process, so seeing this line is how you know the job
    // did not run in the web process.
    this.logger.info(`rendered job ${job.id ?? '?'}`, result);
    return result;
  }
}
