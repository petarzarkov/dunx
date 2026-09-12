import { describe, expect, it } from 'bun:test';
import { Controller, Get } from '@dunx/http';
import { Module } from '@dunx/core';
import { describeRoutes } from './discover.js';
import { generateDocument } from './generate.js';
import { OpenApiExplorer } from './explorer.js';
import { DocsRenderer, type PageOptions } from './renderer.js';
import type { OpenApiDocument } from './types.js';

@Controller('users')
class UsersController {
  @Get()
  list(): readonly string[] {
    return [];
  }
}

@Module({ controllers: [UsersController] })
class UsersModule {}

/** Counts renders and yields the microtask queue, so a concurrent caller can race it. */
class CountingRenderer extends DocsRenderer {
  calls = 0;

  constructor(private readonly fail = false) {
    super();
  }

  async page(
    _document: OpenApiDocument,
    _options: PageOptions,
  ): Promise<string> {
    this.calls += 1;
    await Promise.resolve();
    if (this.fail) throw new Error('render failed');
    return `<html>${this.calls}</html>`;
  }

  asset(): Promise<Response> {
    return Promise.resolve(new Response(null, { status: 404 }));
  }
}

const explorerWith = async (renderer: DocsRenderer) =>
  new OpenApiExplorer(
    await generateDocument(describeRoutes(UsersModule), {
      title: 'T',
      version: '1',
    }),
    '/openapi.json',
    '/docs',
    renderer,
  );

describe('OpenApiExplorer.page', () => {
  it('renders once for concurrent first requests at one prefix', async () => {
    const renderer = new CountingRenderer();
    const explorer = await explorerWith(renderer);

    const pages = await Promise.all(
      Array.from({ length: 8 }, () => explorer.page('')),
    );

    // Caching the resolved value instead of the promise renders eight times.
    expect(renderer.calls).toBe(1);
    expect(new Set(pages).size).toBe(1);
  });

  it('keys the cache by mount prefix', async () => {
    const renderer = new CountingRenderer();
    const explorer = await explorerWith(renderer);

    await explorer.page('');
    await explorer.page('/api');

    expect(renderer.calls).toBe(2);
  });

  it('does not cache a failed render', async () => {
    const renderer = new CountingRenderer(true);
    const explorer = await explorerWith(renderer);

    await expect(explorer.page('')).rejects.toThrow('render failed');
    await expect(explorer.page('')).rejects.toThrow('render failed');

    // A cached rejection would leave the route broken for the process's life.
    expect(renderer.calls).toBe(2);
  });
});
