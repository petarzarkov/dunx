import {
  type EncodedImage,
  ImageError,
  type ImageMetadata,
  Images,
} from '@dunx/images';
import { Logger } from './logger.js';

export interface Variant {
  readonly name: string;
  readonly encoded: EncodedImage;
}

/**
 * Constructor injection, no annotations. `@dunx/compiler` records `[Images,
 * Logger]` from the parameter types at load time and the container resolves them
 * before calling `new`.
 */
export class Thumbnails {
  constructor(
    private readonly images: Images,
    private readonly logger: Logger,
  ) {}

  /** Content-based identification: the extension is never consulted. */
  async identify(source: Uint8Array): Promise<ImageMetadata> {
    this.logger.row('detected container', String(this.images.detect(source)));
    return this.images.verify(source);
  }

  /** One decode, several outputs — the pipeline is immutable, so it forks. */
  async variants(source: Uint8Array): Promise<readonly Variant[]> {
    const base = await this.images.load(source);

    return [
      {
        name: 'webp @ 320 inside',
        encoded: await base
          .resize(320, 320, { fit: 'inside' })
          .to('webp')
          .encode(),
      },
      {
        name: 'jpeg @ 48 fill',
        encoded: await base.resize(48, 48).to('jpeg', { quality: 70 }).encode(),
      },
      {
        name: 'png rotate 90',
        encoded: await base.rotate(90).to('png').encode(),
      },
      {
        name: 'png flop + greyscale',
        encoded: await base
          .flop()
          .modulate({ saturation: 0 })
          .to('png')
          .encode(),
      },
      // The source is untouched by every fork above.
      { name: 'original re-encode', encoded: await base.encode() },
    ];
  }

  async placeholder(source: Uint8Array): Promise<string> {
    return (await this.images.load(source)).placeholder();
  }

  async dataUrl(source: Uint8Array): Promise<string> {
    return (await this.images.load(source))
      .resize(24, 16)
      .to('webp')
      .toDataUrl();
  }

  async writeTo(source: Uint8Array, path: string): Promise<number> {
    // No format chained: Bun infers it from the destination extension.
    return (await this.images.load(source)).toFile(path);
  }

  /** Returns the typed failure instead of letting it escape. */
  async inspectFailure(source: Uint8Array): Promise<ImageError> {
    try {
      await this.images.verify(source);
    } catch (error) {
      if (error instanceof ImageError) return error;
      throw error;
    }
    throw new Error('expected the source to be rejected');
  }
}
