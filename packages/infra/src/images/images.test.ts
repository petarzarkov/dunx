import { afterAll, describe, expect, it } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ImageError, type ImageErrorCode } from './errors.js';
import {
  corruptPng,
  sourceJpeg,
  sourcePng,
  sourceWebp,
  truncatedPng,
} from './fixture.test.js';
import { Images } from './images.js';
import { defaultImagesOptions, withDefaults } from './options.js';

const dir = await mkdtemp(join(tmpdir(), 'dunx-images-svc-'));
afterAll(() => rm(dir, { recursive: true, force: true }));

const images = new Images(defaultImagesOptions);
const png = await sourcePng();
const jpeg = await sourceJpeg();
const webp = await sourceWebp();
const truncated = await truncatedPng();
const corrupt = await corruptPng();

const failure = async (run: () => Promise<unknown>): Promise<ImageError> => {
  const error = await run().then(
    () => undefined,
    (reason: unknown) => reason,
  );
  if (!(error instanceof ImageError)) {
    throw new Error(`expected an ImageError, got ${String(error)}`);
  }
  return error;
};

const codeOf = async (run: () => Promise<unknown>): Promise<ImageErrorCode> =>
  (await failure(run)).code;

describe('Images.detect', () => {
  it('decides from magic bytes', () => {
    expect(images.detect(png)).toBe('png');
    expect(images.detect(jpeg)).toBe('jpeg');
    expect(images.detect(webp)).toBe('webp');
    expect(images.detect(new Uint8Array([0, 1, 2]))).toBeUndefined();
  });

  it('supports() folds detection together with allowedFormats', () => {
    expect(images.supports(jpeg)).toBe(true);
    expect(images.supports(new Uint8Array(4))).toBe(false);

    const pngOnly = new Images(withDefaults({ allowedFormats: ['png'] }));
    expect(pngOnly.supports(png)).toBe(true);
    expect(pngOnly.supports(jpeg)).toBe(false);
  });
});

describe('Images.load', () => {
  it('reports the content format of a misnamed file', async () => {
    const path = join(dir, 'lying.png');
    await Bun.write(path, jpeg);

    const pipeline = await images.load(path);
    expect(pipeline.format).toBe('jpeg');
    expect((await pipeline.sourceMetadata()).format).toBe('jpeg');
  });

  it('rejects bytes with no container signature', async () => {
    expect(await codeOf(() => images.load(new Uint8Array(0)))).toBe(
      'ERR_IMAGE_UNKNOWN_FORMAT',
    );
    expect(await codeOf(() => images.load(new Uint8Array([1, 2, 3])))).toBe(
      'ERR_IMAGE_UNKNOWN_FORMAT',
    );
    expect(
      await codeOf(() =>
        images.load(new TextEncoder().encode('<html>not an image</html>')),
      ),
    ).toBe('ERR_IMAGE_UNKNOWN_FORMAT');
  });

  it('rejects a container excluded by allowedFormats', async () => {
    const pngOnly = new Images(withDefaults({ allowedFormats: ['png'] }));
    const error = await failure(() => pngOnly.load(jpeg));
    expect(error.code).toBe('ERR_IMAGE_FORMAT_NOT_ALLOWED');
    expect(error.message).toContain('jpeg is not permitted');
  });

  it('rejects an input type Bun.Image cannot take', async () => {
    // Response has a .bytes(), so duck-typing would have decoded its body.
    const response = new Response('nope') as unknown as Blob;
    expect(await codeOf(() => images.load(response))).toBe(
      'ERR_IMAGE_UNREADABLE_SOURCE',
    );
    const stream = new Blob(['x']).stream() as unknown as Blob;
    expect(await codeOf(() => images.load(stream))).toBe(
      'ERR_IMAGE_UNREADABLE_SOURCE',
    );
  });
});

describe('Images.metadata', () => {
  it('reads width, height and format', async () => {
    expect(await images.metadata(png)).toEqual({
      width: 64,
      height: 48,
      format: 'png',
    });
    expect(await images.metadata(webp)).toEqual({
      width: 64,
      height: 48,
      format: 'webp',
    });
  });

  it('answers from the header, so a truncated file still succeeds', async () => {
    // Documented Bun behaviour worth pinning: metadata() is not a validity check.
    expect(await images.metadata(truncated)).toEqual({
      width: 64,
      height: 48,
      format: 'png',
    });
  });
});

describe('Images.verify', () => {
  it('confirms an intact image', async () => {
    expect(await images.verify(png)).toEqual({
      width: 64,
      height: 48,
      format: 'png',
    });
  });

  it('catches the truncation that metadata() misses', async () => {
    expect(await codeOf(() => images.verify(truncated))).toBe(
      'ERR_IMAGE_DECODE_FAILED',
    );
  });

  it('catches a corrupted payload behind a valid signature', async () => {
    expect(await codeOf(() => images.verify(corrupt))).toBe(
      'ERR_IMAGE_DECODE_FAILED',
    );
  });

  it('refuses an image over maxPixels before allocating pixels', async () => {
    const strict = new Images(withDefaults({ maxPixels: 16 }));
    expect(await codeOf(() => strict.verify(png))).toBe(
      'ERR_IMAGE_TOO_MANY_PIXELS',
    );
  });

  it('keeps the underlying Bun error as the cause', async () => {
    const error = await failure(() => images.verify(truncated));
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe('ImageError');
    expect((error.cause as { code?: string }).code).toBe(
      'ERR_IMAGE_DECODE_FAILED',
    );
  });
});

describe('Images.config', () => {
  it('exposes the effective configuration', () => {
    const configured = new Images(withDefaults({ quality: 55 }));
    expect(configured.config.quality).toBe(55);
    expect(configured.config.autoOrient).toBe(true);
    expect(configured.config.maxPixels).toBe(defaultImagesOptions.maxPixels);
  });
});
