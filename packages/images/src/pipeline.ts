import { ImageError, ImageErrorCode, toImageError } from './errors.js';
import {
  type EncodableFormat,
  ImageFormat,
  isEncodableFormat,
  mimeTypeOf,
} from './format.js';
import type { ImagesOptions } from './options.js';

/** Resampling kernels `Bun.Image` accepts. `linear` is an alias for `bilinear`. */
export const ResizeFilter = Object.freeze({
  NEAREST: 'nearest',
  BOX: 'box',
  BILINEAR: 'bilinear',
  LINEAR: 'linear',
  CUBIC: 'cubic',
  MITCHELL: 'mitchell',
  LANCZOS2: 'lanczos2',
  LANCZOS3: 'lanczos3',
  MKS2013: 'mks2013',
  MKS2021: 'mks2021',
} as const);

export type ResizeFilter = (typeof ResizeFilter)[keyof typeof ResizeFilter];

/**
 * `FILL` stretches to exactly the requested box, changing the aspect ratio.
 * `INSIDE` scales so the result fits within it, preserving the ratio.
 */
export const ImageFit = Object.freeze({
  FILL: 'fill',
  INSIDE: 'inside',
} as const);

export type ImageFit = (typeof ImageFit)[keyof typeof ImageFit];

export interface ResizeOptions {
  readonly filter?: ResizeFilter;
  /** Defaults to `fill`, matching Bun. */
  readonly fit?: ImageFit;
  /** Leave the image alone when it is already smaller than the target box. */
  readonly withoutEnlargement?: boolean;
}

export interface ModulateOptions {
  /** Multiplier; `1` leaves brightness unchanged. */
  readonly brightness?: number;
  /** `0` is greyscale, `1` unchanged, `>1` more saturated. */
  readonly saturation?: number;
}

export interface QualityOptions {
  /** 1–100. Falls back to `ImagesOptions.quality`. */
  readonly quality?: number;
}

export interface JpegOptions extends QualityOptions {
  readonly progressive?: boolean;
}

export interface PngOptions {
  /** zlib level 0–9. */
  readonly compressionLevel?: number;
  /** Quantize to a palette and emit an indexed PNG. */
  readonly palette?: boolean;
  /** Palette size, 2–256. Only meaningful with `palette`. */
  readonly colors?: number;
  /** Floyd–Steinberg dithering. Only meaningful with `palette`. */
  readonly dither?: boolean;
}

export interface WebpOptions extends QualityOptions {
  readonly lossless?: boolean;
}

export type EncodeOptionsFor<F extends EncodableFormat> = F extends 'jpeg'
  ? JpegOptions
  : F extends 'png'
    ? PngOptions
    : F extends 'webp'
      ? WebpOptions
      : QualityOptions;

type EncodeOptions = JpegOptions & PngOptions & WebpOptions;

export interface ImageMetadata {
  readonly width: number;
  readonly height: number;
  readonly format: ImageFormat;
}

export interface EncodedImage extends ImageMetadata {
  readonly bytes: Uint8Array;
  readonly mimeType: string;
}

/**
 * Operations recorded so far, as a record rather than a list, because that is
 * what the engine does: `Bun.Image` chainables *overwrite* — calling `.resize()`
 * twice keeps only the second — and the pipeline always executes in the fixed
 * order `autoOrient -> rotate -> flip/flop -> resize -> modulate` no matter what
 * order the calls came in.
 */
interface PipelineState {
  readonly resize?: {
    readonly width: number;
    readonly height: number | undefined;
    readonly options: ResizeOptions;
  };
  readonly rotate?: number;
  readonly flip?: boolean;
  readonly flop?: boolean;
  readonly modulate?: ModulateOptions;
  readonly output?: {
    readonly format: EncodableFormat;
    readonly options: EncodeOptions;
  };
}

const clamp = (value: number, limit: number | undefined): number =>
  limit === undefined ? value : Math.min(value, limit);

/**
 * An immutable recipe over one decoded source.
 *
 * Every operation returns a **new** pipeline. `Bun.Image` instead mutates and
 * returns `this`, so handing the same instance to two callers lets one silently
 * reconfigure the other's transform; a pipeline can be shared, forked and
 * re-run safely. Nothing decodes until a terminal is awaited, and each terminal
 * runs the whole recipe from the original bytes.
 */
export class ImagePipeline {
  readonly #bytes: Uint8Array;
  readonly #config: ImagesOptions;
  readonly #state: PipelineState;

  /** The container the *source* bytes actually are, detected from content. */
  readonly format: ImageFormat;

  constructor(
    bytes: Uint8Array,
    format: ImageFormat,
    config: ImagesOptions,
    state: PipelineState = {},
  ) {
    this.#bytes = bytes;
    this.#config = config;
    this.#state = state;
    this.format = format;
  }

  /** Size of the undecoded source in bytes. */
  get byteLength(): number {
    return this.#bytes.byteLength;
  }

  /**
   * The format a terminal will emit.
   *
   * With no `to()` the source format is reused — except for `gif`, `bmp` and
   * `tiff`, which Bun can decode but not encode. Bun's own docs claim it
   * "re-encodes in the source format"; for those three it actually falls back
   * to PNG, and `blob().type` agrees.
   */
  get outputFormat(): ImageFormat {
    if (this.#state.output) return this.#state.output.format;
    return isEncodableFormat(this.format) ? this.format : ImageFormat.PNG;
  }

  #with(state: PipelineState): ImagePipeline {
    return new ImagePipeline(this.#bytes, this.format, this.#config, {
      ...this.#state,
      ...state,
    });
  }

  /**
   * Omit `height` to derive it from the source aspect ratio.
   *
   * `maxWidth`/`maxHeight` from the module configuration are applied here, so a
   * request larger than the configured ceiling is clamped rather than refused.
   */
  resize(
    width: number,
    height?: number,
    options: ResizeOptions = {},
  ): ImagePipeline {
    return this.#with({
      resize: {
        width: clamp(width, this.#config.maxWidth),
        height:
          height === undefined
            ? undefined
            : clamp(height, this.#config.maxHeight),
        options,
      },
    });
  }

  /** Multiples of 90 only; anything else fails at the terminal. */
  rotate(degrees: number): ImagePipeline {
    return this.#with({ rotate: degrees });
  }

  /** Mirror about the x-axis. */
  flip(): ImagePipeline {
    return this.#with({ flip: true });
  }

  /** Mirror about the y-axis. */
  flop(): ImagePipeline {
    return this.#with({ flop: true });
  }

  modulate(options: ModulateOptions): ImagePipeline {
    return this.#with({ modulate: options });
  }

  /** Choose the output container. Only the last call counts. */
  to<F extends EncodableFormat>(
    format: F,
    options: EncodeOptionsFor<F> = {} as EncodeOptionsFor<F>,
  ): ImagePipeline {
    if (!this.#config.allowedFormats.includes(format)) {
      throw new ImageError(
        ImageErrorCode.FORMAT_NOT_ALLOWED,
        `cannot encode to ${format}: allowedFormats is ` +
          `[${this.#config.allowedFormats.join(', ')}]`,
      );
    }
    return this.#with({ output: { format, options } });
  }

  #build(): Bun.Image {
    const { resize, rotate, flip, flop, modulate, output } = this.#state;
    const image = new Bun.Image(this.#bytes, {
      maxPixels: this.#config.maxPixels,
      autoOrient: this.#config.autoOrient,
    });

    if (rotate !== undefined) image.rotate(rotate);
    if (flip) image.flip();
    if (flop) image.flop();
    if (resize) {
      image.resize(resize.width, resize.height, resize.options);
    }
    if (modulate) image.modulate(modulate);
    if (output) applyOutput(image, output.format, output.options, this.#config);
    return image;
  }

  async #run<T>(
    terminal: (image: Bun.Image) => Promise<T>,
    context: string,
  ): Promise<T> {
    try {
      return await terminal(this.#build());
    } catch (cause) {
      throw toImageError(cause, context);
    }
  }

  /**
   * Header-only read of the **source**: `Bun.Image.metadata()` reports the
   * dimensions and format of the input and ignores every recorded operation, so
   * this never reflects a `resize` or a `to`. It also does not decode pixels —
   * a truncated file still answers. Use {@link encode} for the real output.
   */
  sourceMetadata(): Promise<ImageMetadata> {
    return this.#run((image) => image.metadata(), 'could not read metadata');
  }

  /** Run the recipe and report the encoded bytes together with real output dimensions. */
  async encode(): Promise<EncodedImage> {
    const image = this.#build();
    let bytes: Uint8Array;
    try {
      bytes = await image.bytes();
    } catch (cause) {
      throw toImageError(cause, 'could not process image');
    }
    const format = this.outputFormat;
    // The width/height getters are -1 until a pixel terminal has run, and then
    // hold the dimensions that terminal produced.
    return {
      bytes,
      format,
      mimeType: mimeTypeOf(format),
      width: image.width,
      height: image.height,
    };
  }

  toBytes(): Promise<Uint8Array> {
    return this.#run((image) => image.bytes(), 'could not process image');
  }

  toBuffer(): Promise<Buffer> {
    return this.#run((image) => image.buffer(), 'could not process image');
  }

  toBlob(): Promise<Blob> {
    return this.#run((image) => image.blob(), 'could not process image');
  }

  toBase64(): Promise<string> {
    return this.#run((image) => image.toBase64(), 'could not process image');
  }

  /** `data:image/<format>;base64,...`, ready for an `<img src>`. */
  toDataUrl(): Promise<string> {
    return this.#run((image) => image.dataurl(), 'could not process image');
  }

  /**
   * Write the result and resolve to the byte count. A recorded output format
   * wins over `dest`'s extension; with neither, the source format is reused.
   */
  toFile(dest: Bun.BunFile | Bun.PathLike | number): Promise<number> {
    return this.#run((image) => image.write(dest), 'could not write image');
  }

  /**
   * A ThumbHash low-quality placeholder of the **source** as a
   * `data:image/png;base64,...` URL — a <=32px blur, roughly 1–2 KB.
   *
   * Like {@link sourceMetadata} this ignores recorded operations: the
   * placeholder always describes the input image.
   */
  placeholder(): Promise<string> {
    return this.#run(
      (image) => image.placeholder(),
      'could not build placeholder',
    );
  }
}

const applyOutput = (
  image: Bun.Image,
  format: EncodableFormat,
  options: EncodeOptions,
  config: ImagesOptions,
): void => {
  const quality = options.quality ?? config.quality;
  switch (format) {
    case 'jpeg':
      image.jpeg({ quality, ...pick(options, 'progressive') });
      return;
    case 'png':
      image.png(
        pick(options, 'compressionLevel', 'palette', 'colors', 'dither'),
      );
      return;
    case 'webp':
      image.webp({ quality, ...pick(options, 'lossless') });
      return;
    case 'heic':
      image.heic({ quality });
      return;
    case 'avif':
      image.avif({ quality });
      return;
  }
};

// exactOptionalPropertyTypes forbids handing an explicit `undefined` to an
// optional Bun option, so absent keys are dropped rather than spread through.
const pick = <T extends object, K extends keyof T>(
  source: T,
  ...keys: readonly K[]
): Partial<Pick<T, K>> => {
  const out: Partial<Pick<T, K>> = {};
  for (const key of keys) {
    if (source[key] !== undefined) out[key] = source[key];
  }
  return out;
};
