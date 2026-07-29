import { describe, expect, it } from 'bun:test';
import {
  EncodableFormat,
  ImageFormat,
  isEncodableFormat,
  isImageFormat,
  mimeTypeOf,
  sniffFormat,
} from './format.js';
import { sourceJpeg, sourcePng, sourceWebp } from './fixture.test.js';

const bytes = (...values: number[]): Uint8Array => new Uint8Array(values);

const ftyp = (brand: string): Uint8Array => {
  const out = new Uint8Array(16);
  out.set(new TextEncoder().encode('ftyp'), 4);
  out.set(new TextEncoder().encode(brand), 8);
  return out;
};

describe('sniffFormat', () => {
  it('identifies real encoder output rather than trusting a caller', async () => {
    expect(sniffFormat(await sourcePng())).toBe(ImageFormat.PNG);
    expect(sniffFormat(await sourceJpeg())).toBe(ImageFormat.JPEG);
    expect(sniffFormat(await sourceWebp())).toBe(ImageFormat.WEBP);
  });

  it('matches every container signature', () => {
    expect(
      sniffFormat(bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)),
    ).toBe('png');
    expect(sniffFormat(bytes(0xff, 0xd8, 0xff, 0xe0))).toBe('jpeg');
    expect(sniffFormat(new TextEncoder().encode('RIFF____WEBPVP8 '))).toBe(
      'webp',
    );
    expect(sniffFormat(new TextEncoder().encode('GIF89a...'))).toBe('gif');
    expect(sniffFormat(new TextEncoder().encode('GIF87a...'))).toBe('gif');
    expect(sniffFormat(new TextEncoder().encode('BM______'))).toBe('bmp');
    expect(sniffFormat(bytes(0x49, 0x49, 0x2a, 0x00))).toBe('tiff');
    expect(sniffFormat(bytes(0x4d, 0x4d, 0x00, 0x2a))).toBe('tiff');
    expect(sniffFormat(ftyp('avif'))).toBe('avif');
    expect(sniffFormat(ftyp('heic'))).toBe('heic');
    expect(sniffFormat(ftyp('mif1'))).toBe('heic');
  });

  it('returns undefined for anything without a signature', () => {
    expect(sniffFormat(new Uint8Array(0))).toBeUndefined();
    expect(sniffFormat(bytes(1, 2, 3))).toBeUndefined();
    expect(
      sniffFormat(new TextEncoder().encode('not an image')),
    ).toBeUndefined();
    expect(sniffFormat(new TextEncoder().encode('GIF77a'))).toBeUndefined();
    expect(sniffFormat(ftyp('qt  '))).toBeUndefined();
  });

  it('does not read past the end of a short buffer', () => {
    expect(sniffFormat(bytes(0x89, 0x50))).toBeUndefined();
    expect(sniffFormat(new TextEncoder().encode('RIFF'))).toBeUndefined();
  });

  it('reports the content, not the extension', async () => {
    // The bytes of a JPEG, whatever a caller decided to name the file.
    expect(sniffFormat(await sourceJpeg())).toBe('jpeg');
  });
});

describe('format guards', () => {
  it('accepts every value Bun can report from metadata()', () => {
    for (const format of Object.values(ImageFormat)) {
      expect(isImageFormat(format)).toBe(true);
      expect(mimeTypeOf(format).startsWith('image/')).toBe(true);
    }
  });

  it('rejects non-formats', () => {
    expect(isImageFormat('svg')).toBe(false);
    expect(isImageFormat('JPEG')).toBe(false);
    expect(isImageFormat(undefined)).toBe(false);
    expect(isImageFormat(7)).toBe(false);
  });

  it('separates encodable from decode-only', () => {
    for (const format of Object.values(EncodableFormat)) {
      expect(isEncodableFormat(format)).toBe(true);
    }
    for (const format of ['bmp', 'tiff', 'gif']) {
      expect(isImageFormat(format)).toBe(true);
      expect(isEncodableFormat(format)).toBe(false);
    }
  });
});
