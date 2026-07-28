import { afterAll, describe, expect, it } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ImageError, ImageErrorCode } from './errors.js';
import { sourceJpeg, sourcePng } from './fixture.test.js';
import { readSource } from './source.js';

const dir = await mkdtemp(join(tmpdir(), 'dunx-images-'));
afterAll(() => rm(dir, { recursive: true, force: true }));

describe('readSource', () => {
  it('normalises every accepted input to the same bytes', async () => {
    const png = await sourcePng();
    const path = join(dir, 'seed.png');
    await Bun.write(path, png);

    const inputs = {
      Uint8Array: png,
      Buffer: Buffer.from(png),
      ArrayBuffer: png.buffer as ArrayBuffer,
      Blob: new Blob([png]),
      BunFile: Bun.file(path),
      path,
      dataUrl: await new Bun.Image(png).png().dataurl(),
    };

    for (const [label, input] of Object.entries(inputs)) {
      const read = await readSource(input);
      expect(read.byteLength, label).toBe(png.byteLength);
      expect(Buffer.from(read).equals(Buffer.from(png)), label).toBe(true);
    }
  });

  it('honours the byteOffset of a view into a larger buffer', async () => {
    const png = await sourcePng();
    const padded = new Uint8Array(png.byteLength + 16);
    padded.set(png, 16);
    const read = await readSource(padded.subarray(16));
    expect(Buffer.from(read).equals(Buffer.from(png))).toBe(true);
  });

  it('reads a file whose extension lies about its contents', async () => {
    const jpeg = await sourceJpeg();
    const path = join(dir, 'actually-a-jpeg.png');
    await Bun.write(path, jpeg);
    expect(Buffer.from(await readSource(path)).equals(Buffer.from(jpeg))).toBe(
      true,
    );
  });

  it('reports a missing path as UNREADABLE_SOURCE, not a raw syscall throw', async () => {
    const error = await readSource(join(dir, 'nope.png')).catch(
      (reason: unknown) => reason,
    );
    expect(error).toBeInstanceOf(ImageError);
    expect((error as ImageError).code).toBe(ImageErrorCode.UNREADABLE_SOURCE);
    expect((error as ImageError).message).toContain('ENOENT');
  });

  it('reports a directory as UNREADABLE_SOURCE', async () => {
    const error = await readSource(dir).catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(ImageError);
    expect((error as ImageError).code).toBe(ImageErrorCode.UNREADABLE_SOURCE);
  });

  it('keeps the original throw as the cause', async () => {
    const error = (await readSource(join(dir, 'nope.png')).catch(
      (reason: unknown) => reason,
    )) as ImageError;
    expect(error.cause).toBeInstanceOf(Error);
  });
});
