import { AppFactory, Module } from '@dunx/core';
import { describe, expect, it } from 'bun:test';
import { sourcePng } from './fixture.test.js';
import { Images } from './images.js';
import { ImagesModule } from './images.module.js';
import { defaultImagesOptions, ImagesOptions } from './options.js';

const png = await sourcePng();

describe('ImagesModule.forRoot', () => {
  it('binds Images and ImagesOptions with defaults applied', async () => {
    const app = await AppFactory.create(ImagesModule.forRoot());

    expect(app.get(Images)).toBeInstanceOf(Images);
    expect(app.get(ImagesOptions)).toEqual(defaultImagesOptions);
    expect(await app.get(Images).metadata(png)).toEqual({
      width: 64,
      height: 48,
      format: 'png',
    });
  });

  it('merges the given options over the defaults', async () => {
    @Module({
      imports: [ImagesModule.forRoot({ quality: 42, maxWidth: 32 })],
    })
    class Root {}

    const app = await AppFactory.create(Root);
    const options = app.get(ImagesOptions);

    expect(options.quality).toBe(42);
    expect(options.maxWidth).toBe(32);
    expect(options.autoOrient).toBe(defaultImagesOptions.autoOrient);
    expect(options.maxPixels).toBe(defaultImagesOptions.maxPixels);
  });

  it('hands the resolved options to Images', async () => {
    const app = await AppFactory.create(
      ImagesModule.forRoot({ allowedFormats: ['png'] }),
    );
    const images = app.get(Images);

    expect(images.config).toBe(app.get(ImagesOptions));
    expect(images.config.allowedFormats).toEqual(['png']);
  });

  it('awaits a config loader before any constructor runs', async () => {
    @Module({
      imports: [
        ImagesModule.forRoot(async () => {
          await Bun.sleep(1);
          return { quality: 91 };
        }),
      ],
    })
    class Root {}

    const app = await AppFactory.create(Root);
    // No forRootAsync needed: dunx resolves eagerly and settles factories first.
    expect(app.get(ImagesOptions).quality).toBe(91);
    expect(app.get(Images).config.quality).toBe(91);
  });

  it('accepts a synchronous config loader too', async () => {
    const app = await AppFactory.create(
      ImagesModule.forRoot(() => ({ quality: 33 })),
    );
    expect(app.get(Images).config.quality).toBe(33);
  });

  it('is injectable into a consumer by constructor', async () => {
    class Thumbnails {
      constructor(private readonly images: Images) {}

      async small(source: Uint8Array): Promise<string> {
        const out = await (
          await this.images.load(source)
        )
          .resize(16, 16, { fit: 'inside' })
          .to('webp')
          .encode();
        return `${out.width}x${out.height} ${out.mimeType}`;
      }
    }
    // @dunx/transform records this at build time from the parameter type; the
    // in-package suite has no preload, so it is stated here explicitly.
    Object.defineProperty(Thumbnails, Symbol.for('dunx.deps'), {
      value: () => [Images],
    });

    @Module({
      imports: [ImagesModule.forRoot()],
      providers: [Thumbnails],
    })
    class Root {}

    const app = await AppFactory.create(Root);
    expect(await app.get(Thumbnails).small(png)).toBe('16x12 image/webp');
  });

  it('reuses one Images instance across the container', async () => {
    class First {
      constructor(readonly images: Images) {}
    }
    class Second {
      constructor(readonly images: Images) {}
    }
    for (const ctor of [First, Second]) {
      Object.defineProperty(ctor, Symbol.for('dunx.deps'), {
        value: () => [Images],
      });
    }

    @Module({ imports: [ImagesModule.forRoot()], providers: [First, Second] })
    class Root {}

    const app = await AppFactory.create(Root);
    expect(app.get(First).images).toBe(app.get(Second).images);
  });
});
