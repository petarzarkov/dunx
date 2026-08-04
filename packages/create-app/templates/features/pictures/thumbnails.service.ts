import { Logger } from '@dunx/core';
import {
  EncodableFormat,
  type EncodedImage,
  ImageFit,
  Images,
  ImagesOptions,
} from '@dunx/infra/images';

/**
 * A 4x4 RGB gradient PNG - the only binary in the example, and small enough to
 * read as a constant. Everything larger is derived from it at runtime by
 * `Bun.Image` itself, so nothing is checked in and nothing is downloaded.
 */
const SEED_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAQAAAAECAIAAAAmkwkpAAAAKElEQVR42g3HMQEAAAzC' +
  'MEzip3pqki1fktBgWEhKi2X9SEWZn9Hh2DgEahfxpRmu7gAAAABJRU5ErkJggg==';

export interface RenderOptions {
  readonly width: number;
  readonly height?: number | undefined;
  readonly fit: ImageFit;
  readonly format: EncodableFormat;
  readonly quality?: number | undefined;
}

export class Thumbnails {
  constructor(
    private readonly images: Images,
    private readonly config: ImagesOptions,
    private readonly logger: Logger,
  ) {}

  /** The 64x48 source every route below derives from, grown from the 4x4 seed. */
  private async source(): Promise<Uint8Array> {
    const seed = new Uint8Array(Buffer.from(SEED_PNG_BASE64, 'base64'));
    const seeded = await this.images.load(seed);
    return seeded
      .resize(64, 48, { fit: ImageFit.FILL })
      .to(EncodableFormat.PNG)
      .toBytes();
  }

  async render(options: RenderOptions): Promise<EncodedImage> {
    const pipeline = await this.images.load(await this.source());
    const resized = pipeline.resize(options.width, options.height, {
      fit: options.fit,
    });
    // A quality only means something to a lossy encoder, so it is only passed
    // when one was asked for.
    return options.quality === undefined
      ? resized.to(options.format).encode()
      : resized.to(options.format, { quality: options.quality }).encode();
  }

  async describe(
    base64: string,
  ): Promise<{ width: number; height: number; format: string }> {
    const bytes = new Uint8Array(Buffer.from(base64, 'base64'));
    const meta = await this.images.metadata(bytes);
    return { width: meta.width, height: meta.height, format: meta.format };
  }

  async demonstrate(): Promise<void> {
    const { images, logger } = this;
    const seed = new Uint8Array(Buffer.from(SEED_PNG_BASE64, 'base64'));

    const seeded = await images.load(seed);
    const source = await seeded
      .resize(64, 48, { fit: ImageFit.FILL })
      .to(EncodableFormat.PNG)
      .toBytes();
    logger.info(
      `quality=${this.config.quality}, generated a 64x48 source from the 4x4 seed ` +
        `at runtime: ${source.byteLength} bytes, detected ${images.detect(source)}`,
    );

    // Content-based: the container comes from magic bytes, never a filename. And
    // this is a header read, not a decode - a truncated file would still answer.
    const meta = await images.metadata(source);
    logger.info(`metadata -> ${meta.width}x${meta.height} ${meta.format}`);

    const pipeline = await images.load(source);
    const thumb = await pipeline
      .resize(16, 16, { fit: ImageFit.INSIDE })
      .encode();
    logger.info(
      `resize 16x16 inside -> ${thumb.width}x${thumb.height} ${thumb.format}, ` +
        `${thumb.bytes.byteLength} bytes`,
    );

    const webp = await pipeline
      .resize(32)
      .to(EncodableFormat.WEBP, { quality: 70 })
      .encode();
    logger.info(
      `convert 32px wide -> ${webp.width}x${webp.height} ${webp.mimeType}, ` +
        `${webp.bytes.byteLength} bytes`,
    );

    // `Bun.Image` mutates and returns `this`; an ImagePipeline returns a new
    // value from every operation, so the two resizes above did not collide.
    const again = await pipeline.sourceMetadata();
    logger.info(
      `the pipeline is immutable: the source is still ${again.width}x${again.height} ${again.format}`,
    );
  }
}
