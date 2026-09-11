import { Controller, Delete, Get, type Input } from '@dunx/http';
import { z } from 'zod';
import { Catalog, type Quote } from './catalog.service.js';

const QuoteParams = z
  .object({ symbol: z.string().min(1).max(12) })
  .meta({ id: 'QuoteSymbol', description: 'The instrument to quote' });

const oneQuote = { params: QuoteParams } as const;

/**
 * `Cache.wrap` behind three routes: read one, read it again, drop it. The second
 * read of a symbol leaves `loads` where it was.
 */
@Controller('catalog')
export class CatalogController {
  constructor(private readonly catalog: Catalog) {}

  @Get('/', {})
  stats(): { loads: number } {
    return { loads: this.catalog.loads };
  }

  @Get('/:symbol', oneQuote)
  quote({ params }: Input<typeof oneQuote>): Promise<Quote> {
    return this.catalog.quote(params.symbol);
  }

  @Delete('/:symbol', oneQuote)
  async evict({
    params,
  }: Input<typeof oneQuote>): Promise<{ evicted: boolean }> {
    return { evicted: await this.catalog.evict(params.symbol) };
  }
}
