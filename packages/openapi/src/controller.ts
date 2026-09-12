import { inject, type Ctor } from '@dunx/core';
import {
  ApiHidden,
  Controller,
  Get,
  Public,
  type Input,
  type RouteSchemas,
} from '@dunx/http';
import { joinPath } from '@dunx/http/internal';
import { OpenApiExplorer } from './explorer.js';
import { mountPrefix } from './mount.js';
import type { DocsRenderer } from './renderer.js';

export interface DocPaths {
  json: string;
  ui: string;
}

/**
 * The controller is built per `forRoot`/`forRootAsync` call because its paths are
 * configuration, and the routes are then discovered, guarded, CORS-wrapped and
 * middleware-wrapped exactly like any other controller's. Nothing is mounted behind
 * the app's back.
 *
 * The paths are read through a closure rather than captured, because a decorator's
 * arguments are evaluated when the class definition is and `forRootAsync`'s are not
 * known until a provider has run. `@Get` takes a `RoutePath` thunk for exactly
 * this: route discovery happens after every provider has settled, so by the time
 * anything reads a path, the factory that produced it has returned.
 */
const documentController = (paths: DocPaths) => {
  @Controller()
  class OpenApiController {
    // inject() in a field initializer, not a constructor parameter: this package
    // works with or without the @dunx/transform preload.
    protected readonly explorer = inject(OpenApiExplorer);

    @Public()
    @Get(() => paths.json)
    document(input: Input<RouteSchemas>): Response {
      return new Response(this.explorer.json(this.prefix(input, paths.json)), {
        headers: { 'content-type': 'application/json; charset=utf-8' },
      });
    }

    protected prefix(input: Input<RouteSchemas>, declared: string): string {
      return mountPrefix(new URL(input.req.url).pathname, declared);
    }
  }

  return OpenApiController;
};

/**
 * The document's routes, plus the page and its assets when a renderer is
 * configured. Two classes rather than one with dead routes: a `/docs` in the
 * table that answers 404 is worse than no `/docs`.
 *
 * Both are named `OpenApiController`, so the operation ids and the tag the
 * document gives its own routes do not move with the renderer.
 */
export const buildController = (
  paths: DocPaths,
  renderer: DocsRenderer | undefined,
): Ctor<object> => {
  const base = documentController(paths);
  if (renderer === undefined) return base;

  @Controller()
  class OpenApiController extends base {
    @Public()
    @Get(() => paths.ui)
    async page(input: Input<RouteSchemas>): Promise<Response> {
      const html = await this.explorer.page(this.prefix(input, paths.ui));
      return new Response(html, {
        headers: { 'content-type': 'text/html; charset=utf-8' },
      });
    }

    /**
     * The renderer's files, served from the consumer's install as siblings of
     * the page. One wildcard rather than a route per file, since the renderer's
     * `AssetPackage` is the allow-list. Not a `{ dir }` route either: Bun 1.4's
     * directory routes cannot set `cache-control` and answer any method
     * (docs/bun-apis.md).
     *
     * `@ApiHidden` because a stylesheet in an OpenAPI document is noise, while
     * `/docs` and `/openapi.json` are endpoints someone calls.
     */
    @ApiHidden()
    @Public()
    @Get(() => joinPath(paths.ui, '/*'))
    asset(input: Input<RouteSchemas>): Promise<Response> {
      const { pathname } = new URL(input.req.url);
      return this.explorer.asset(pathname.slice(pathname.lastIndexOf('/') + 1));
    }
  }

  return OpenApiController;
};
