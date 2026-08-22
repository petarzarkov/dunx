import { Controller, Get, Post, type Input } from '@dunx/http';
import { EncodableFormat, ImageFit } from '@dunx/infra/images';
import { z } from 'zod';
import { Thumbnails } from './thumbnails.service.js';

const Resize = z
  .object({
    width: z.coerce.number().int().min(1).max(1024).default(64),
    height: z.coerce.number().int().min(1).max(1024).optional(),
    fit: z.enum(ImageFit).default(ImageFit.INSIDE),
    format: z.enum(EncodableFormat).default(EncodableFormat.PNG),
    quality: z.coerce.number().int().min(1).max(100).optional(),
  })
  .meta({
    id: 'Resize',
    description: 'How to render the generated source image',
  });

const render = { query: Resize } as const;
const describe = {
  body: z
    .object({ base64: z.string().min(1) })
    .meta({ id: 'InlineImage', description: 'Any image, base64-encoded' }),
} as const;

/**
 * Every byte here is produced at runtime by `Bun.Image` from a 4x4 seed, so the
 * example checks in no binaries and downloads nothing.
 */
@Controller('images')
export class ImagesController {
  constructor(private readonly thumbnails: Thumbnails) {}

  /** Returns the encoded image itself, so a browser renders it inline. */
  @Get('/render', render)
  async render(input: Input<typeof render>): Promise<Response> {
    const encoded = await this.thumbnails.render(input.query);
    return new Response(encoded.bytes, {
      headers: {
        'content-type': encoded.mimeType,
        'x-dimensions': `${encoded.width}x${encoded.height}`,
      },
    });
  }

  /** The same render, described rather than returned - easier to read in swagger. */
  @Get('/metadata', render)
  async metadata(input: Input<typeof render>): Promise<{
    width: number;
    height: number;
    format: string;
    mimeType: string;
    bytes: number;
  }> {
    const encoded = await this.thumbnails.render(input.query);
    return {
      width: encoded.width,
      height: encoded.height,
      format: encoded.format,
      mimeType: encoded.mimeType,
      bytes: encoded.bytes.byteLength,
    };
  }

  /**
   * Format detection is content-based - magic bytes, never a filename - and this
   * is a header read rather than a decode, so a truncated file still answers.
   */
  @Post('/describe', describe)
  describe(input: Input<typeof describe>): Promise<{
    width: number;
    height: number;
    format: string;
  }> {
    return this.thumbnails.describe(input.body.base64);
  }
}
