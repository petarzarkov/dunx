import { AppFactory } from '@dunx/core';
import { ImageError, Images, ImagesOptions } from '@dunx/images';
import { describe, expect, it } from 'bun:test';
import { AppModule } from './app.module.js';
import { buildSourcePng, corruptPng } from './seed.js';
import { Thumbnails } from './thumbnails.service.js';

const app = await AppFactory.create(AppModule);
const source = await buildSourcePng();

describe('the example app', () => {
  it('resolves Thumbnails by constructor injection', () => {
    // Proof the @dunx/compiler preload is doing its job: Thumbnails declares
    // (Images, Logger) and neither is annotated anywhere.
    expect(Thumbnails.length).toBe(2);
    expect(app.get(Thumbnails)).toBeInstanceOf(Thumbnails);
    expect(app.get(Images)).toBeInstanceOf(Images);
  });

  it('applies the configuration from forRoot', () => {
    const options = app.get(ImagesOptions);
    expect(options.quality).toBe(82);
    expect(options.maxWidth).toBe(256);
    expect(options.allowedFormats).toEqual(['png', 'jpeg', 'webp']);
  });

  it('identifies the runtime-built source by content', async () => {
    expect(await app.get(Thumbnails).identify(source)).toEqual({
      width: 96,
      height: 64,
      format: 'png',
    });
  });

  it('forks one pipeline into independent variants', async () => {
    const variants = await app.get(Thumbnails).variants(source);
    const shapes = variants.map(
      ({ name, encoded }) =>
        `${name}=${encoded.width}x${encoded.height}:${encoded.format}`,
    );

    expect(shapes).toEqual([
      // 320 was clamped to the configured maxWidth of 256.
      'webp @ 320 inside=256x171:webp',
      'jpeg @ 48 fill=48x48:jpeg',
      'png rotate 90=64x96:png',
      'png flop + greyscale=96x64:png',
      'original re-encode=96x64:png',
    ]);
  });

  it('reports corrupt bytes as a typed error rather than crashing', async () => {
    const failure = await app
      .get(Thumbnails)
      .inspectFailure(await corruptPng());
    expect(failure).toBeInstanceOf(ImageError);
    expect(failure.code).toBe('ERR_IMAGE_DECODE_FAILED');
  });
});
