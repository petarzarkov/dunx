/**
 * The container formats `Bun.Image` can identify. Matches `Bun.Image.Format`
 * one-for-one, so a value read from `metadata().format` is always one of these.
 *
 * Frozen object plus an indexed-access union, not an `enum` — see CLAUDE.md.
 */
export const ImageFormat = Object.freeze({
  JPEG: 'jpeg',
  PNG: 'png',
  WEBP: 'webp',
  HEIC: 'heic',
  AVIF: 'avif',
  BMP: 'bmp',
  TIFF: 'tiff',
  GIF: 'gif',
} as const);

export type ImageFormat = (typeof ImageFormat)[keyof typeof ImageFormat];

/**
 * The subset Bun has an encoder for. `bmp`, `tiff` and `gif` decode only —
 * there is no `.bmp()`/`.tiff()`/`.gif()` on `Bun.Image`, so they can be read
 * but never written.
 */
export const EncodableFormat = Object.freeze({
  JPEG: 'jpeg',
  PNG: 'png',
  WEBP: 'webp',
  HEIC: 'heic',
  AVIF: 'avif',
} as const);

export type EncodableFormat =
  (typeof EncodableFormat)[keyof typeof EncodableFormat];

const FORMATS: readonly ImageFormat[] = Object.values(ImageFormat);
const ENCODABLE: readonly ImageFormat[] = Object.values(EncodableFormat);

const MIME_TYPES: Readonly<Record<ImageFormat, string>> = Object.freeze({
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
  heic: 'image/heic',
  avif: 'image/avif',
  bmp: 'image/bmp',
  tiff: 'image/tiff',
  gif: 'image/gif',
});

export const isImageFormat = (value: unknown): value is ImageFormat =>
  typeof value === 'string' && FORMATS.includes(value as ImageFormat);

export const isEncodableFormat = (value: unknown): value is EncodableFormat =>
  typeof value === 'string' && ENCODABLE.includes(value as ImageFormat);

export const mimeTypeOf = (format: ImageFormat): string => MIME_TYPES[format];

const startsWith = (bytes: Uint8Array, prefix: readonly number[]): boolean => {
  if (bytes.length < prefix.length) return false;
  return prefix.every((byte, index) => bytes[index] === byte);
};

const ascii = (bytes: Uint8Array, at: number, length: number): string => {
  if (bytes.length < at + length) return '';
  let out = '';
  for (let i = at; i < at + length; i++) out += String.fromCharCode(bytes[i]!);
  return out;
};

// ISO base media brands. `mif1`/`msf1` are the generic HEIF brands a HEIC file
// may carry instead of a heic-specific one; Bun reports all of them as `heic`.
const HEIC_BRANDS = new Set([
  'heic',
  'heix',
  'heim',
  'heis',
  'hevc',
  'hevx',
  'hevm',
  'hevs',
  'mif1',
  'msf1',
]);
const AVIF_BRANDS = new Set(['avif', 'avis']);

/**
 * Identify a container from its leading bytes. Content, never filename — a
 * `.png` holding JPEG bytes reports `jpeg`.
 *
 * `undefined` means no signature matched, which is the same condition Bun
 * raises `ERR_IMAGE_UNKNOWN_FORMAT` for once a pipeline runs.
 */
export const sniffFormat = (bytes: Uint8Array): ImageFormat | undefined => {
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) {
    return ImageFormat.PNG;
  }
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return ImageFormat.JPEG;
  if (ascii(bytes, 0, 4) === 'RIFF' && ascii(bytes, 8, 4) === 'WEBP') {
    return ImageFormat.WEBP;
  }
  if (ascii(bytes, 0, 3) === 'GIF' && startsWith(bytes, [0x47])) {
    const version = ascii(bytes, 3, 3);
    if (version === '87a' || version === '89a') return ImageFormat.GIF;
  }
  if (ascii(bytes, 0, 2) === 'BM') return ImageFormat.BMP;
  if (
    startsWith(bytes, [0x49, 0x49, 0x2a, 0x00]) ||
    startsWith(bytes, [0x4d, 0x4d, 0x00, 0x2a])
  ) {
    return ImageFormat.TIFF;
  }
  if (ascii(bytes, 4, 4) === 'ftyp') {
    const brand = ascii(bytes, 8, 4);
    if (AVIF_BRANDS.has(brand)) return ImageFormat.AVIF;
    if (HEIC_BRANDS.has(brand)) return ImageFormat.HEIC;
  }
  return undefined;
};
