import { AppError } from '@dunx/core';

/**
 * Every failure this package raises, as a stable string code.
 *
 * The `ERR_IMAGE_*` and `ERR_INVALID_*` values are Bun's own - `Bun.Image`
 * rejects with a plain `Error`/`TypeError` carrying `error.code`, and those
 * codes are passed through unchanged so a caller can switch on one code space.
 * The last two are added here for conditions Bun has no code for.
 */
export const ImageErrorCode = Object.freeze({
  /** No container signature matched. Empty input, text, arbitrary bytes. */
  UNKNOWN_FORMAT: 'ERR_IMAGE_UNKNOWN_FORMAT',
  /** Header was valid, pixel data was not. Truncated or corrupted payload. */
  DECODE_FAILED: 'ERR_IMAGE_DECODE_FAILED',
  ENCODE_FAILED: 'ERR_IMAGE_ENCODE_FAILED',
  /** HEIC/AVIF/TIFF without an OS codec - see ImagesModule docs. */
  FORMAT_UNSUPPORTED: 'ERR_IMAGE_FORMAT_UNSUPPORTED',
  /** `width * height` exceeded `maxPixels`, refused before pixel allocation. */
  TOO_MANY_PIXELS: 'ERR_IMAGE_TOO_MANY_PIXELS',
  INVALID_STATE: 'ERR_INVALID_STATE',
  /** Bad argument: a non-multiple-of-90 rotation, an unknown resize filter. */
  INVALID_ARGUMENT: 'ERR_INVALID_ARG_TYPE',
  /** The source could not be read at all - bad path, unreadable file, closed blob. */
  UNREADABLE_SOURCE: 'ERR_IMAGE_UNREADABLE_SOURCE',
  /** Recognised, decodable, but excluded by `allowedFormats`. */
  FORMAT_NOT_ALLOWED: 'ERR_IMAGE_FORMAT_NOT_ALLOWED',
} as const);

export type ImageErrorCode =
  (typeof ImageErrorCode)[keyof typeof ImageErrorCode];

const CODES: readonly string[] = Object.values(ImageErrorCode);

export class ImageError extends AppError {
  override name = 'ImageError';

  constructor(
    readonly code: ImageErrorCode,
    message: string,
    cause?: unknown,
  ) {
    super(message, cause === undefined ? undefined : { cause });
  }
}

interface SystemError {
  readonly code?: unknown;
  readonly syscall?: unknown;
  readonly path?: unknown;
  readonly message?: unknown;
}

const read = (value: unknown): SystemError =>
  typeof value === 'object' && value !== null ? (value as SystemError) : {};

/**
 * Translate whatever `Bun.Image` threw into an `ImageError`.
 *
 * Bun's own `ERR_*` codes survive verbatim. A file-backed source surfaces the
 * raw syscall code instead (`ENOENT`, `EACCES`, `ENODEV` for a directory), and
 * those collapse to `UNREADABLE_SOURCE` with the original code kept in the
 * message. Anything else is reported as a decode failure, which is what an
 * unrecognised throw from a decode pipeline amounts to.
 */
export const toImageError = (cause: unknown, context: string): ImageError => {
  if (cause instanceof ImageError) return cause;

  const { code, syscall, path } = read(cause);
  const detail = cause instanceof Error ? cause.message : String(cause);

  if (typeof code === 'string' && CODES.includes(code)) {
    return new ImageError(
      code as ImageErrorCode,
      `${context}: ${detail}`,
      cause,
    );
  }

  if (
    typeof code === 'string' &&
    (syscall !== undefined || path !== undefined)
  ) {
    return new ImageError(
      ImageErrorCode.UNREADABLE_SOURCE,
      `${context}: ${detail} (${code})`,
      cause,
    );
  }

  return new ImageError(
    ImageErrorCode.DECODE_FAILED,
    `${context}: ${detail}`,
    cause,
  );
};
