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

  // `background: true` puts this queue's jobs in a forked child: a slow or
  // crashing render cannot take the server with it, and its log lines still land
  // in this process's stream.
  @JobHandler({ queue: THUMBNAIL_QUEUE, name: 'render', background: true })
  async render(job: Job<RenderRequest>): Promise<RenderResult> {
    const started = Bun.nanoseconds();
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
    const elapsedMs = (Bun.nanoseconds() - started) / 1e6;
    // Written in the child, and visible here: that is the point of the sandbox.
    this.logger.info(
      `rendered job ${job.id ?? '?'} in ${elapsedMs.toFixed(2)} ms`,
      result,
    );

    return result;
  }
}
