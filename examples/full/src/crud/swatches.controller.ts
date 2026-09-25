import { Controller, Deprecated, Get } from '@dunx/http';
import { ApiDoc } from '@dunx/openapi';
import { ColorsStore } from './colors.controller.js';

/** `#e8590c` as `[232, 89, 12]`. */
const rgbOf = (hex: string): readonly [number, number, number] => [
  Number.parseInt(hex.slice(1, 3), 16),
  Number.parseInt(hex.slice(3, 5), 16),
  Number.parseInt(hex.slice(5, 7), 16),
];

/**
 * Version 1 answers bare hex strings, and every response says it is going:
 * `Deprecation`, `Sunset` and a `Link` to the guide. The document marks each
 * operation deprecated.
 */
@ApiDoc({ tags: ['Versioning'] })
@Deprecated({
  since: '2026-09-01',
  sunset: '2027-03-01',
  link: 'https://dunx.win/guide/versioning',
})
@Controller('swatches', { version: '1' })
export class SwatchesV1Controller {
  constructor(private readonly store: ColorsStore) {}

  @Get('/')
  list(): readonly string[] {
    return this.store.list().map((color) => color.hex);
  }
}

/** Version 2 names each swatch and adds its RGB channels. */
@ApiDoc({ tags: ['Versioning'] })
@Controller('swatches', { version: '2' })
export class SwatchesV2Controller {
  constructor(private readonly store: ColorsStore) {}

  @Get('/')
  list(): readonly {
    id: string;
    hex: string;
    rgb: readonly [number, number, number];
  }[] {
    return this.store
      .list()
      .map((color) => ({ ...color, rgb: rgbOf(color.hex) }));
  }
}
