import {
  EncodableFormat,
  ImageFit,
  Images,
  ImagesOptions,
} from '@dunx/infra/images';
import { Logger } from '../logger.js';

/**
 * A 4x4 RGB gradient PNG — the only binary in the example, and small enough to
 * read as a constant. Everything larger is derived from it at runtime by
 * `Bun.Image` itself, so nothing is checked in and nothing is downloaded.
 */
const SEED_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAQAAAAECAIAAAAmkwkpAAAAKElEQVR42g3HMQEAAAzC' +
  'MEzip3pqki1fktBgWEhKi2X9SEWZn9Hh2DgEahfxpRmu7gAAAABJRU5ErkJggg==';

export class Thumbnails {
  constructor(
    private readonly images: Images,
    private readonly config: ImagesOptions,
    private readonly logger: Logger,
  ) {}

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
    // this is a header read, not a decode — a truncated file would still answer.
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
