import { ImageFormat } from './format.js';

/**
 * The configuration contract, modelled as an `abstract class` so it is a
 * runtime value and therefore a usable injection token. An `interface` here
 * would erase and `@dunx/compiler` would record the parameter as `unresolved`.
 *
 * Resolve it to read the effective configuration:
 * `constructor(private readonly config: ImagesOptions) {}`.
 */
export abstract class ImagesOptions {
  /** Encoder quality for JPEG/WebP/HEIC/AVIF when a call does not override it. */
  abstract readonly quality: number;
  /**
   * Refuse a source whose `width * height` exceeds this. Checked after the
   * header is parsed but before any pixel buffer is allocated, so a small file
   * declaring an enormous canvas is rejected cheaply.
   */
  abstract readonly maxPixels: number;
  /** Apply the JPEG EXIF `Orientation` tag before any other operation. */
  abstract readonly autoOrient: boolean;
  /** Containers that may be decoded, and encoded to. */
  abstract readonly allowedFormats: readonly ImageFormat[];
  /** Upper bound applied to every requested resize width. */
  abstract readonly maxWidth: number | undefined;
  /** Upper bound applied to every requested resize height. */
  abstract readonly maxHeight: number | undefined;
}

export type ImagesOptionsInput = Partial<ImagesOptions>;

/**
 * `maxPixels` matches Bun's own default of `0x3FFF * 0x3FFF`. `allowedFormats`
 * starts as every container Bun can identify: HEIC and AVIF still fail at
 * encode time on a machine with no OS codec, but that is the runtime's answer
 * to give, reported as `ERR_IMAGE_FORMAT_UNSUPPORTED`, not a policy decision
 * this package should make for a caller.
 */
export const defaultImagesOptions: ImagesOptions = Object.freeze({
  quality: 80,
  maxPixels: 0x3fff * 0x3fff,
  autoOrient: true,
  allowedFormats: Object.freeze(Object.values(ImageFormat)),
  maxWidth: undefined,
  maxHeight: undefined,
});

// Field by field rather than a spread: `ImagesOptions` is an abstract class, and
// spreading something typed as a class instance drops its prototype.
export const withDefaults = (input: ImagesOptionsInput): ImagesOptions =>
  Object.freeze({
    quality: input.quality ?? defaultImagesOptions.quality,
    maxPixels: input.maxPixels ?? defaultImagesOptions.maxPixels,
    autoOrient: input.autoOrient ?? defaultImagesOptions.autoOrient,
    allowedFormats: input.allowedFormats ?? defaultImagesOptions.allowedFormats,
    maxWidth: input.maxWidth ?? defaultImagesOptions.maxWidth,
    maxHeight: input.maxHeight ?? defaultImagesOptions.maxHeight,
  });
