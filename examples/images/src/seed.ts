/**
 * A 4x4 RGB gradient PNG, embedded as base64 so the example needs no binary
 * fixture and no network. Anything larger is derived from it by `Bun.Image`.
 */
const SEED_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAQAAAAECAIAAAAmkwkpAAAAKElEQVR42g3HMQEAAAzC' +
  'MEzip3pqki1fktBgWEhKi2X9SEWZn9Hh2DgEahfxpRmu7gAAAABJRU5ErkJggg==';

/** A 96x64 PNG built at runtime — non-square, so aspect ratio is observable. */
export const buildSourcePng = async (): Promise<Uint8Array> =>
  new Bun.Image(new Uint8Array(Buffer.from(SEED_PNG_BASE64, 'base64')))
    .resize(96, 64, { fit: 'fill' })
    .png()
    .bytes();

/** A valid PNG signature followed by shredded pixel data. */
export const corruptPng = async (): Promise<Uint8Array> => {
  const png = new Uint8Array(await buildSourcePng());
  png.fill(0x5a, 30, png.byteLength - 8);
  return png;
};
