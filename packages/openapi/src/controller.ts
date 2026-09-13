import { inject, type Ctor } from '@dunx/core';
import {
  ApiHidden,
  Controller,
  gate,
  Get,
  Public,
  type Authorize,
  type Input,
  type RouteSchemas,
} from '@dunx/http';
import { joinPath } from '@dunx/http/internal';
import { OpenApiExplorer } from './explorer.js';
import { mountPrefix } from './mount.js';
import type { DocsRenderer } from './renderer.js';

export interface DocMount {
  json: string;
  ui: string;
  authorize: Authorize | undefined;
}

/**
 * Built per `forRoot`/`forRootAsync` call, its paths being configuration, and the
 * routes then discovered, guarded, CORS-wrapped and middleware-wrapped like any
 * other controller's. Nothing is mounted behind the app's back.
 *
 * The mount is read through a closure: a decorator's arguments evaluate with the
 * class definition, and `forRootAsync`'s are not known until a provider has run.
 * `@Get` takes a `RoutePath` thunk for that, discovery happening after every
 * provider has settled.
 *
 * Every route is `@Public()`, so no session guard answers ahead of `authorize`:
 * a 401 from one would confirm the mount exists.
 */
const documentController = (mount: DocMount) => {
  @Controller()
  class OpenApiController {
    // inject() in a field initializer, not a constructor parameter: this package
    // works with or without the @dunx/transform preload.
    protected readonly explorer = inject(OpenApiExplorer);

    @Public()
    @Get(() => mount.json)
    async document(input: Input<RouteSchemas>): Promise<Response> {
      const refused = await this.refuse(input);
      if (refused !== undefined) return refused;

      return new Response(this.explorer.json(this.prefix(input, mount.json)), {
        headers: { 'content-type': 'application/json; charset=utf-8' },
      });
    }

    protected prefix(input: Input<RouteSchemas>, declared: string): string {
      return mountPrefix(new URL(input.req.url).pathname, declared);
    }

    protected refuse(
      input: Input<RouteSchemas>,
    ): Promise<Response | undefined> {
      return gate(mount.authorize, input.req);
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
  mount: DocMount,
  renderer: DocsRenderer | undefined,
): Ctor<object> => {
  const base = documentController(mount);
  if (renderer === undefined) return base;

  @Controller()
  class OpenApiController extends base {
    @Public()
    @Get(() => mount.ui)
    async page(input: Input<RouteSchemas>): Promise<Response> {
      const refused = await this.refuse(input);
      if (refused !== undefined) return refused;

      const html = await this.explorer.page(this.prefix(input, mount.ui));
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
     * Gated with the page: a page whose script is a refusal renders blank.
     *
     * `@ApiHidden` because a stylesheet in an OpenAPI document is noise, while
     * `/docs` and `/openapi.json` are endpoints someone calls.
     */
    @ApiHidden()
    @Public()
    @Get(() => joinPath(mount.ui, '/*'))
    async asset(input: Input<RouteSchemas>): Promise<Response> {
      const refused = await this.refuse(input);
      if (refused !== undefined) return refused;

      const { pathname } = new URL(input.req.url);
      return this.explorer.asset(pathname.slice(pathname.lastIndexOf('/') + 1));
    }
  }

  return OpenApiController;
};
