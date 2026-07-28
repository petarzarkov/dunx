import { AppFactory } from '@dunx/core';
import { ImagesOptions } from '@dunx/images';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AppModule } from './app.module.js';
import { Logger } from './logger.js';
import { buildSourcePng, corruptPng } from './seed.js';
import { Thumbnails } from './thumbnails.service.js';

const app = await AppFactory.create(AppModule);
app.enableShutdownHooks();

const log = app.get(Logger);
const thumbnails = app.get(Thumbnails);
const options = app.get(ImagesOptions);
const dir = await mkdtemp(join(tmpdir(), 'dunx-images-example-'));

log.info(
  `backend=${Bun.Image.backend} quality=${options.quality} ` +
    `maxWidth=${options.maxWidth} allowed=[${options.allowedFormats.join(', ')}]`,
);

const source = await buildSourcePng();
log.info(`source built at runtime: ${source.byteLength} bytes`);

log.info('metadata');
const meta = await thumbnails.identify(source);
log.row('verified', `${meta.width}x${meta.height} ${meta.format}`);

log.info('variants from one immutable pipeline');
for (const { name, encoded } of await thumbnails.variants(source)) {
  log.row(
    name,
    `${encoded.width}x${encoded.height} ${encoded.mimeType} ` +
      `${encoded.bytes.byteLength} bytes`,
  );
}

log.info('derived assets');
const placeholder = await thumbnails.placeholder(source);
log.row('ThumbHash placeholder', `${placeholder.length} chars`);
log.row('  starts with', `${placeholder.slice(0, 34)}...`);
const dataUrl = await thumbnails.dataUrl(source);
log.row('24x16 webp data URL', `${dataUrl.length} chars`);
log.row('  starts with', `${dataUrl.slice(0, 34)}...`);

const written = join(dir, 'thumb.jpg');
log.row(
  'written to disk',
  `${await thumbnails.writeTo(source, written)} bytes`,
);
const onDisk = await thumbnails.identify(await Bun.file(written).bytes());
log.row(
  '  format on disk',
  `${onDisk.width}x${onDisk.height} ${onDisk.format}`,
);

log.info('typed error path');
const failure = await thumbnails.inspectFailure(await corruptPng());
log.row('code', failure.code);
log.row('name', failure.name);
log.row('cause code', String((failure.cause as { code?: string }).code));
log.row('message', failure.message);

const rejected = await thumbnails
  .identify(new TextEncoder().encode('<html>not an image</html>'))
  .then(
    () => 'unexpectedly accepted',
    (error: unknown) =>
      error instanceof Error
        ? `${error.name} ${String(Reflect.get(error, 'code'))}`
        : 'unknown',
  );
log.row('non-image bytes', rejected);

await rm(dir, { recursive: true, force: true });
await app.shutdown();
log.info('shut down cleanly');
