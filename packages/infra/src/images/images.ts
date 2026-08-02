import { ImageError, ImageErrorCode } from './errors.js';
import { type ImageFormat, sniffFormat } from './format.js';
import { ImagesOptions } from './options.js';
import { type ImageMetadata, ImagePipeline } from './pipeline.js';
import { type ImageSource, readSource } from './source.js';

/**
 * Decode, inspect and transform images on `Bun.Image`.
 *
 * Inject it by constructor:
 *
 * ```ts
 * export class Thumbnails {
 *   constructor(private readonly images: Images) {}
 * }
 * ```
 */
export class Images {
  readonly #config: ImagesOptions;

  constructor(config: ImagesOptions) {
    this.#config = config;
  }

  /** The effective configuration, after `forRoot` defaults were applied. */
  get config(): ImagesOptions {
    return this.#config;
  }

  /**
   * Identify a container from its magic bytes. Never looks at a filename, so a
   * `.png` holding JPEG bytes reports `jpeg`. `undefined` when nothing matched.
   */
  detect(bytes: Uint8Array): ImageFormat | undefined {
    return sniffFormat(bytes);
  }

  /** Whether {@link detect} finds a container that `allowedFormats` permits. */
  supports(bytes: Uint8Array): boolean {
    const format = sniffFormat(bytes);
    return format !== undefined && this.#config.allowedFormats.includes(format);
  }

  /**
   * Read a source, identify it by content, and return a pipeline over it.
   *
   * Throws `ImageError` with `UNKNOWN_FORMAT` when no signature matches and
   * `FORMAT_NOT_ALLOWED` when the container is excluded by `allowedFormats`.
   * Nothing is decoded yet - a structurally intact header with corrupt pixels
   * only fails once a terminal runs, or immediately via {@link verify}.
   */
  async load(source: ImageSource): Promise<ImagePipeline> {
    const bytes = await readSource(source);
    const format = sniffFormat(bytes);

    if (format === undefined) {
      throw new ImageError(
        ImageErrorCode.UNKNOWN_FORMAT,
        `unrecognised image container (${bytes.byteLength} bytes); expected ` +
          'one of jpeg, png, webp, heic, avif, bmp, tiff, gif',
      );
    }

    if (!this.#config.allowedFormats.includes(format)) {
      throw new ImageError(
        ImageErrorCode.FORMAT_NOT_ALLOWED,
        `${format} is not permitted: allowedFormats is ` +
          `[${this.#config.allowedFormats.join(', ')}]`,
      );
    }

    return new ImagePipeline(bytes, format, this.#config);
  }

  /**
   * Width, height and format of a source, read from its header.
   *
   * Cheap, and *not* a validity check: `Bun.Image` answers this from the header
   * alone, so a truncated file still reports its declared dimensions. Use
   * {@link verify} when the pixels have to be known-good.
   */
  async metadata(source: ImageSource): Promise<ImageMetadata> {
    return (await this.load(source)).sourceMetadata();
  }

  /**
   * Fully decode a source to prove it is intact, then report its metadata.
   *
   * This is the check {@link metadata} is not: it raises `DECODE_FAILED` for a
   * truncated or corrupted payload, `FORMAT_UNSUPPORTED` when the machine has
   * no codec for the container, and `TOO_MANY_PIXELS` past `maxPixels`.
   */
  async verify(source: ImageSource): Promise<ImageMetadata> {
    const pipeline = await this.load(source);
    const { width, height, format } = await pipeline.encode();
    return { width, height, format };
  }
}
