import { expect, it } from 'bun:test';

/**
 * A 4x4 RGB gradient PNG, hand-encoded once and embedded so the suite needs no
 * binary fixture and no network. Everything larger is derived from it at runtime
 * by `Bun.Image` itself.
 */
const SEED_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAQAAAAECAIAAAAmkwkpAAAAKElEQVR42g3HMQEAAAzC' +
  'MEzip3pqki1fktBgWEhKi2X9SEWZn9Hh2DgEahfxpRmu7gAAAABJRU5ErkJggg==';

export const seedPng = (): Uint8Array =>
  new Uint8Array(Buffer.from(SEED_PNG_BASE64, 'base64'));

/** A 64x48 PNG - non-square, so aspect-ratio behaviour is observable. */
export const sourcePng = async (): Promise<Uint8Array> =>
  new Bun.Image(seedPng()).resize(64, 48, { fit: 'fill' }).png().bytes();

export const sourceJpeg = async (): Promise<Uint8Array> =>
  new Bun.Image(await sourcePng()).jpeg({ quality: 90 }).bytes();

export const sourceWebp = async (): Promise<Uint8Array> =>
  new Bun.Image(await sourcePng()).webp().bytes();

/** Header intact, pixel data cut in half - decodes only as far as metadata. */
export const truncatedPng = async (): Promise<Uint8Array> => {
  const png = await sourcePng();
  return png.subarray(0, png.byteLength >> 1);
};

/** Valid PNG signature, garbage after it. */
export const corruptPng = async (): Promise<Uint8Array> => {
  const png = new Uint8Array(await sourcePng());
  png.fill(0x5a, 30, png.byteLength - 8);
  return png;
};

it('builds a 64x48 source from the embedded seed at runtime', async () => {
  expect(await new Bun.Image(seedPng()).metadata()).toEqual({
    width: 4,
    height: 4,
    format: 'png',
  });
  expect(await new Bun.Image(await sourcePng()).metadata()).toEqual({
    width: 64,
    height: 48,
    format: 'png',
  });
});
