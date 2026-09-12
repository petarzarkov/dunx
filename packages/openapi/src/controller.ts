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
 * Built per `forRoot`/`forRootAsync` call, its paths being configuration, and the
 * routes then discovered, guarded, CORS-wrapped and middleware-wrapped like any
 * other controller's. Nothing is mounted behind the app's back.
 *
 * The paths are read through a closure: a decorator's arguments evaluate with the
 * class definition, and `forRootAsync`'s are not known until a provider has run.
 * `@Get` takes a `RoutePath` thunk for that, discovery happening after every
 * provider has settled.
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
 * The document's routes, plus the page and its assets when a renderer is set. Two
 * classes rather than one with dead routes, a `/docs` answering 404 being worse
 * than none. Both are named `OpenApiController`, so operation ids and the tag do
 * not move with the renderer.
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
