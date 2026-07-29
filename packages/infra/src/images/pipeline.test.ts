import { afterAll, describe, expect, it } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ImageError } from './errors.js';
import { sniffFormat } from './format.js';
import { sourceJpeg, sourcePng, truncatedPng } from './fixture.test.js';
import { Images } from './images.js';
import { defaultImagesOptions, withDefaults } from './options.js';

const dir = await mkdtemp(join(tmpdir(), 'dunx-images-pipe-'));
afterAll(() => rm(dir, { recursive: true, force: true }));

const images = new Images(defaultImagesOptions);
const png = await sourcePng();
const jpeg = await sourceJpeg();
const truncated = await truncatedPng();

// One pipeline shared by the whole suite. Safe precisely because operations are
// immutable — with a raw Bun.Image every test would reconfigure its neighbours.
const base = await images.load(png);

const dims = async (bytes: Uint8Array): Promise<string> => {
  const { width, height } = await images.metadata(bytes);
  return `${width}x${height}`;
};

describe('conversions', () => {
  it('re-encodes into every format Bun has an encoder for here', async () => {
    for (const format of ['png', 'jpeg', 'webp'] as const) {
      const out = await base.to(format).encode();
      expect(out.format, format).toBe(format);
      expect(out.mimeType, format).toBe(`image/${format}`);
      expect(sniffFormat(out.bytes), format).toBe(format);
      expect(out.width, format).toBe(64);
      expect(out.height, format).toBe(48);
    }
  });

  it('reports the source format when nothing was requested', async () => {
    const out = await (await images.load(jpeg)).encode();
    expect(out.format).toBe('jpeg');
    expect(sniffFormat(out.bytes)).toBe('jpeg');
  });

  it('honours per-call quality over the configured default', async () => {
    const low = await base.to('jpeg', { quality: 1 }).toBytes();
    const high = await base.to('jpeg', { quality: 100 }).toBytes();
    expect(low.byteLength).toBeLessThan(high.byteLength);
  });

  it('uses ImagesOptions.quality when a call does not say', async () => {
    const lossy = new Images(withDefaults({ quality: 1 }));
    const fine = new Images(withDefaults({ quality: 100 }));
    const small = await (await lossy.load(png)).to('jpeg').toBytes();
    const large = await (await fine.load(png)).to('jpeg').toBytes();
    expect(small.byteLength).toBeLessThan(large.byteLength);
  });

  it('applies png palette options', async () => {
    const plain = await base.to('png').toBytes();
    const paletted = await base
      .to('png', { palette: true, colors: 4, dither: true })
      .toBytes();
    expect(paletted.byteLength).not.toBe(plain.byteLength);
    expect(sniffFormat(paletted)).toBe('png');
  });

  it('applies jpeg and webp options', async () => {
    expect(
      sniffFormat(await base.to('jpeg', { progressive: true }).toBytes()),
    ).toBe('jpeg');
    expect(
      sniffFormat(await base.to('webp', { lossless: true }).toBytes()),
    ).toBe('webp');
  });

  it('reports a format with no codec on this machine as a typed error', async () => {
    const error = await base
      .to('avif')
      .toBytes()
      .catch((reason: unknown) => reason);
    if (Bun.Image.backend === 'bun') {
      expect(error).toBeInstanceOf(ImageError);
      expect((error as ImageError).code).toBe('ERR_IMAGE_FORMAT_UNSUPPORTED');
    } else {
      expect(error).toBeInstanceOf(Uint8Array);
    }
  });

  it('refuses a target excluded by allowedFormats', async () => {
    const pngOnly = new Images(withDefaults({ allowedFormats: ['png'] }));
    const pipeline = await pngOnly.load(png);
    expect(() => pipeline.to('webp')).toThrow(ImageError);
  });
});

describe('resize', () => {
  it('derives the height from the aspect ratio when it is omitted', async () => {
    expect(await dims(await base.resize(32).toBytes())).toBe('32x24');
  });

  it('stretches to the exact box by default (fit: fill)', async () => {
    expect(await dims(await base.resize(32, 32).toBytes())).toBe('32x32');
  });

  it('preserves the ratio with fit: inside', async () => {
    const small = await base.resize(32, 32, { fit: 'inside' }).toBytes();
    const large = await base.resize(200, 200, { fit: 'inside' }).toBytes();
    expect(await dims(small)).toBe('32x24');
    expect(await dims(large)).toBe('200x150');
  });

  it('leaves a smaller source alone with withoutEnlargement', async () => {
    const out = await base
      .resize(200, 200, { fit: 'inside', withoutEnlargement: true })
      .toBytes();
    expect(await dims(out)).toBe('64x48');
  });

  it('accepts every resampling filter, including the linear alias', async () => {
    for (const filter of [
      'nearest',
      'box',
      'bilinear',
      'linear',
      'cubic',
      'mitchell',
      'lanczos2',
      'lanczos3',
      'mks2013',
      'mks2021',
    ] as const) {
      const out = await base.resize(20, 20, { filter }).toBytes();
      expect(await dims(out), filter).toBe('20x20');
    }
  });

  it('clamps a request to the configured maxWidth/maxHeight', async () => {
    const capped = new Images(withDefaults({ maxWidth: 40, maxHeight: 30 }));
    const pipeline = await capped.load(png);
    expect(await dims(await pipeline.resize(1000, 1000).toBytes())).toBe(
      '40x30',
    );
    expect(await dims(await pipeline.resize(10, 10).toBytes())).toBe('10x10');
  });

  it('keeps only the last resize, matching Bun', async () => {
    const out = await base.resize(10, 10).resize(20, 20).toBytes();
    expect(await dims(out)).toBe('20x20');
  });
});

describe('geometry and colour', () => {
  it('swaps the axes on a quarter turn only', async () => {
    expect(await dims(await base.rotate(90).toBytes())).toBe('48x64');
    expect(await dims(await base.rotate(180).toBytes())).toBe('64x48');
    expect(await dims(await base.rotate(270).toBytes())).toBe('48x64');
    expect(await dims(await base.rotate(-90).toBytes())).toBe('48x64');
  });

  it('rejects a rotation that is not a multiple of 90', async () => {
    const error = await base
      .rotate(45)
      .toBytes()
      .catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(ImageError);
    expect((error as ImageError).code).toBe('ERR_INVALID_ARG_TYPE');
  });

  it('mirrors without changing dimensions', async () => {
    const plain = await base.toBytes();
    const flipped = await base.flip().toBytes();
    const flopped = await base.flop().toBytes();
    expect(await dims(flipped)).toBe('64x48');
    expect(await dims(flopped)).toBe('64x48');
    expect(Buffer.from(flipped).equals(Buffer.from(plain))).toBe(false);
    expect(Buffer.from(flopped).equals(Buffer.from(flipped))).toBe(false);
  });

  it('modulates brightness and saturation', async () => {
    const plain = await base.toBytes();
    const bright = await base.modulate({ brightness: 1.6 }).toBytes();
    const grey = await base.modulate({ saturation: 0 }).toBytes();
    expect(Buffer.from(bright).equals(Buffer.from(plain))).toBe(false);
    expect(Buffer.from(grey).equals(Buffer.from(plain))).toBe(false);
  });
});

describe('chaining', () => {
  it('is immutable — an operation never mutates the pipeline it came from', async () => {
    const small = base.resize(8, 8);
    const large = base.resize(48, 48);

    expect((await images.metadata(await small.toBytes())).width).toBe(8);
    expect((await images.metadata(await large.toBytes())).width).toBe(48);
    // Bun.Image would have returned `this` from both calls and kept only 48.
    expect((await images.metadata(await base.toBytes())).width).toBe(64);
    expect(small).not.toBe(base);
  });

  it('composes rotate, flip, resize, modulate and a format change', async () => {
    const out = await base
      .rotate(90)
      .flop()
      .resize(24, 24, { fit: 'inside' })
      .modulate({ saturation: 0.5 })
      .to('webp', { quality: 60 })
      .encode();

    // rotate(90) makes it 48x64, then fit:inside into 24x24 gives 18x24.
    expect({ width: out.width, height: out.height }).toEqual({
      width: 18,
      height: 24,
    });
    expect(out.format).toBe('webp');
    expect(sniffFormat(out.bytes)).toBe('webp');
  });

  it('re-runs the whole recipe on each terminal', async () => {
    const pipeline = base.resize(16, 16).to('png');
    const first = await pipeline.toBytes();
    const second = await pipeline.toBytes();
    expect(Buffer.from(first).equals(Buffer.from(second))).toBe(true);
  });

  it('exposes the source format and the pending output format', async () => {
    const pipeline = await images.load(jpeg);
    expect(pipeline.format).toBe('jpeg');
    expect(pipeline.outputFormat).toBe('jpeg');
    expect(pipeline.to('webp').outputFormat).toBe('webp');
    expect(pipeline.byteLength).toBe(jpeg.byteLength);
  });
});

describe('terminals', () => {
  const webp = () => base.to('webp');

  it('emits bytes, a Buffer, a Blob, base64 and a data URL', async () => {
    expect(await webp().toBytes()).toBeInstanceOf(Uint8Array);
    expect(Buffer.isBuffer(await webp().toBuffer())).toBe(true);

    const blob = await webp().toBlob();
    expect(blob.type).toBe('image/webp');
    expect(blob.size).toBeGreaterThan(0);

    expect(await webp().toBase64()).toMatch(/^[A-Za-z0-9+/]+=*$/);
    expect(await webp().toDataUrl()).toStartWith('data:image/webp;base64,');
  });

  it('round-trips its own data URL back through load()', async () => {
    const url = await base.resize(20, 15).to('png').toDataUrl();
    expect(await images.metadata(url)).toEqual({
      width: 20,
      height: 15,
      format: 'png',
    });
  });

  it('writes a file and infers the format from the extension', async () => {
    const path = join(dir, 'out.jpg');
    expect(await base.toFile(path)).toBeGreaterThan(0);
    expect(await images.metadata(path)).toEqual({
      width: 64,
      height: 48,
      format: 'jpeg',
    });
  });

  it('lets a requested format win over the destination extension', async () => {
    const path = join(dir, 'misnamed.png');
    await base.to('webp').toFile(path);
    expect((await images.metadata(path)).format).toBe('webp');
  });

  it('produces a ThumbHash placeholder of the source', async () => {
    const placeholder = await base.placeholder();
    expect(placeholder).toStartWith('data:image/png;base64,');
    expect(placeholder.length).toBeLessThan(4096);

    const meta = await images.metadata(placeholder);
    expect(meta.format).toBe('png');
    expect(Math.max(meta.width, meta.height)).toBeLessThanOrEqual(32);
  });

  it('ignores recorded operations in placeholder(), as Bun does', async () => {
    expect(await base.resize(8, 8).placeholder()).toBe(
      await base.placeholder(),
    );
  });

  it('reports the source in sourceMetadata() even after a resize', async () => {
    const pipeline = base.resize(8, 8).to('webp');
    // Bun.Image.metadata() reads the input header and ignores the chain.
    expect(await pipeline.sourceMetadata()).toEqual({
      width: 64,
      height: 48,
      format: 'png',
    });
    const encoded = await pipeline.encode();
    expect({ width: encoded.width, height: encoded.height }).toEqual({
      width: 8,
      height: 8,
    });
  });

  it('turns a corrupt payload into a typed error on every terminal', async () => {
    const pipeline = await images.load(truncated);
    const terminals: readonly [string, () => Promise<unknown>][] = [
      ['toBytes', () => pipeline.toBytes()],
      ['toBuffer', () => pipeline.toBuffer()],
      ['toBlob', () => pipeline.toBlob()],
      ['toBase64', () => pipeline.toBase64()],
      ['toDataUrl', () => pipeline.toDataUrl()],
      ['encode', () => pipeline.encode()],
      ['placeholder', () => pipeline.placeholder()],
      ['toFile', () => pipeline.toFile(join(dir, 'never.png'))],
    ];

    for (const [name, run] of terminals) {
      const error = await run().catch((reason: unknown) => reason);
      expect(error, name).toBeInstanceOf(ImageError);
      expect((error as ImageError).code, name).toBe('ERR_IMAGE_DECODE_FAILED');
    }
  });
});
