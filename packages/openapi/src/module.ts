import {
  inject,
  provide,
  type Deps,
  type DynamicModule,
  type FactoryProvider,
  type ModuleRef,
} from '@dunx/core';
import {
  ApiHidden,
  Controller,
  Get,
  joinPath,
  Public,
  type Input,
  type RouteSchemas,
} from '@dunx/http';
import { describeRoutes } from './discover.js';
import {
  generateDocument,
  type DocumentInfo,
  type GeneratedDocument,
} from './generate.js';
import { renderShell } from './html.js';
import { mountPrefix, withPrefix } from './mount.js';
import {
  ASSET_CACHE_CONTROL,
  contentTypeOf,
  isSwaggerAsset,
  SwaggerAssets,
} from './swagger.js';
import type { OpenApiDocument } from './types.js';
import type { SwaggerUiOptions } from './ui-options.js';

/** Everything about the document itself, which is everything a factory can produce. */
export interface OpenApiInfo extends DocumentInfo {
  /** Where the HTML page is mounted. Default `/docs`. */
  readonly path?: string;
  /** Where the document is mounted. Default `/openapi.json`. */
  readonly jsonPath?: string;
  /**
   * Everything Swagger UI takes, plus the `favicon` and `title` dunx owns.
   * `@dunx/openapi` sets `deepLinking: true`, `layout: 'BaseLayout'` and
   * `validatorUrl: null` under whatever you pass; see {@link SwaggerUiOptions}.
   */
  readonly ui?: SwaggerUiOptions;
}

export interface OpenApiOptions extends OpenApiInfo {
  /**
   * The module graph to document. It is also what gets imported, so this configured
   * module is what you hand `HttpFactory.create()` - one root, named once.
   */
  readonly root: ModuleRef;
}

/**
 * `forRootAsync`'s argument: the root, plus the factory that produces everything
 * else. `root` stays here rather than coming out of the factory because it is a
 * module reference - the graph has to exist before the container that would run
 * the factory does.
 */
export interface OpenApiAsyncOptions<D extends Deps> extends FactoryProvider<
  OpenApiInfo,
  D
> {
  readonly root: ModuleRef;
}

/**
 * The generated document, plus the two renderings of it the controller serves. Built
 * once at boot - the request path only serialises - and keyed by mount prefix,
 * because `setGlobalPrefix()` is applied after the container is built.
 */
export class OpenApiExplorer {
  /** Every schema that degraded. Readable straight after `HttpFactory.create()`. */
  readonly warnings: readonly string[];
  readonly #base: OpenApiDocument;
  readonly #absolutePaths: ReadonlySet<string>;
  readonly #jsonPath: string;
  readonly #uiPath: string;
  readonly #ui: SwaggerUiOptions;
  readonly #documents = new Map<string, OpenApiDocument>();
  readonly #json = new Map<string, string>();
  readonly #pages = new Map<string, string>();

  constructor(
    generated: GeneratedDocument,
    jsonPath: string,
    uiPath: string,
    ui: SwaggerUiOptions = {},
  ) {
    this.#base = generated.document;
    this.#absolutePaths = generated.absolutePaths;
    this.warnings = generated.warnings;
    this.#jsonPath = jsonPath;
    this.#uiPath = uiPath;
    this.#ui = ui;
  }

  document(prefix = ''): OpenApiDocument {
    const cached = this.#documents.get(prefix);
    if (cached !== undefined) return cached;
    const document = withPrefix(this.#base, prefix, this.#absolutePaths);
    this.#documents.set(prefix, document);
    return document;
  }

  json(prefix = ''): string {
    const cached = this.#json.get(prefix);
    if (cached !== undefined) return cached;
    const serialised = JSON.stringify(this.document(prefix));
    this.#json.set(prefix, serialised);
    return serialised;
  }

  /**
   * The page, built on the first request for a given mount prefix and cached.
   *
   * `SwaggerAssets.resolve()` happens here rather than at boot. `swagger-ui-dist`
   * is a **dependency** of this package, so it is always installed; resolving it
   * lazily means an app serving only `/openapi.json` never pays the lookup, and a
   * broken install surfaces as this route failing rather than as a boot error for
   * everyone.
   */
  async page(prefix = ''): Promise<string> {
    const cached = this.#pages.get(prefix);
    if (cached !== undefined) return cached;
    const html = renderShell(
      this.document(prefix),
      {
        jsonHref: joinPath(prefix, this.#jsonPath),
        warnings: this.warnings,
        mountedAt: joinPath(prefix, this.#uiPath),
        ui: this.#ui,
      },
      await SwaggerAssets.resolve(),
    );
    this.#pages.set(prefix, html);
    return html;
  }

  /**
   * One allow-listed Swagger UI file, straight off disk.
   *
   * A name that is not on the list is a 404 rather than a read, which is what makes
   * one wildcard route safe over a directory that also holds four other builds and
   * 4 MB of sourcemaps.
   */
  async asset(name: string): Promise<Response> {
    if (!isSwaggerAsset(name)) {
      return new Response('Not found', { status: 404 });
    }
    const assets = await SwaggerAssets.resolve();
    return new Response(Bun.file(assets.pathOf(name)), {
      headers: {
        'cache-control': ASSET_CACHE_CONTROL,
        'content-type': contentTypeOf(name),
      },
    });
  }
}

interface DocPaths {
  json: string;
  ui: string;
  /** Swagger UI configuration, mutated in place by `forRootAsync`'s factory. */
  uiOptions: SwaggerUiOptions;
}

const DEFAULT_PATHS: Readonly<DocPaths> = Object.freeze({
  json: '/openapi.json',
  ui: '/docs',
  uiOptions: Object.freeze({}),
});

const pathsFrom = (info: OpenApiInfo): DocPaths => ({
  json: info.jsonPath ?? DEFAULT_PATHS.json,
  ui: info.path ?? DEFAULT_PATHS.ui,
  uiOptions: info.ui ?? DEFAULT_PATHS.uiOptions,
});

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
const buildController = (paths: DocPaths) => {
  @Controller()
  class OpenApiController {
    // inject() in a field initializer, not a constructor parameter: this package
    // works with or without the @dunx/transform preload.
    readonly #explorer = inject(OpenApiExplorer);

    @Public()
    @Get(() => paths.json)
    document(input: Input<RouteSchemas>): Response {
      return new Response(
        this.#explorer.json(this.#prefix(input, paths.json)),
        {
          headers: { 'content-type': 'application/json; charset=utf-8' },
        },
      );
    }

    @Public()
    @Get(() => paths.ui)
    async page(input: Input<RouteSchemas>): Promise<Response> {
      const html = await this.#explorer.page(this.#prefix(input, paths.ui));
      return new Response(html, {
        headers: { 'content-type': 'text/html; charset=utf-8' },
      });
    }

    /**
     * Swagger UI's files, served from the consumer's `swagger-ui-dist` install as
     * siblings of the page.
     *
     * One wildcard rather than a route per file, because the allow-list lives in
     * `ASSETS` in `swagger.ts` and four handlers differing only by a string literal
     * would be that list written twice. Not a `{ dir }` route either: Bun 1.4's
     * directory routes cannot set `cache-control` and serve the file body for any
     * HTTP method, including `OPTIONS` (docs/bun-apis.md).
     *
     * `@ApiHidden` because these are the only routes in this controller that are
     * not API. The document deliberately describes its own `/docs` and
     * `/openapi.json` - they are endpoints someone calls - but a stylesheet in an
     * OpenAPI document is noise.
     */
    @ApiHidden()
    @Public()
    @Get(() => joinPath(paths.ui, '/*'))
    asset(input: Input<RouteSchemas>): Promise<Response> {
      const { pathname } = new URL(input.req.url);
      return this.#explorer.asset(
        pathname.slice(pathname.lastIndexOf('/') + 1),
      );
    }

    #prefix(input: Input<RouteSchemas>, declared: string): string {
      return mountPrefix(new URL(input.req.url).pathname, declared);
    }
  }

  return OpenApiController;
};

export class OpenApiModule {
  /**
   * ```ts
   * const app = await HttpFactory.create(
   *   OpenApiModule.forRoot({ title: 'API', version: '1.0.0', root: AppModule }),
   * );
   * ```
   *
   * The factory is async, so the whole document - every schema conversion included -
   * is settled before the first constructor runs and `warnings` is readable at boot.
   */
  static forRoot(options: OpenApiOptions): DynamicModule {
    const paths = pathsFrom(options);

    const configured: DynamicModule = {
      module: OpenApiModule,
      imports: [options.root],
      // The generated document, so an app can read `warnings` or serve the JSON
      // itself. This module wraps the app's root rather than being imported by it,
      // so the export is what makes `app.get(OpenApiExplorer)` resolve.
      exports: [OpenApiExplorer],
      controllers: [buildController(paths)],
      providers: [
        provide(OpenApiExplorer, {
          // `configured` includes the controller above, so the document describes the
          // documentation routes too. They are routes; pretending otherwise would be
          // the first lie in the file.
          useFactory: async () =>
            new OpenApiExplorer(
              await generateDocument(describeRoutes(configured), options),
              paths.json,
              paths.ui,
              paths.uiOptions,
            ),
        }),
      ],
    };

    return configured;
  }

  /**
   * The same module, with `title`, `version`, `description`, `servers`, `path` and
   * `jsonPath` produced by a factory that may await and may itself inject - which
   * is the one thing `forRoot` cannot do, and the reason every other configurable
   * module has this pair:
   *
   * ```ts
   * OpenApiModule.forRootAsync({
   *   root: AppModule,
   *   useFactory: (config: AppConfigService) => ({
   *     title: config.get('app').name,
   *     version: config.get('app').version,
   *     path: config.get('app').docsPath,
   *   }),
   *   inject: [AppConfigService],
   * });
   * ```
   *
   * The mount paths come out of the factory too, so they are as configurable as
   * the rest. That works because the controller's routes are declared with path
   * thunks and route discovery runs after every provider has settled: the factory
   * below fills `paths` before it generates a document, and both the document and
   * the served table read the filled values.
   */
  static forRootAsync<const D extends Deps>(
    options: OpenApiAsyncOptions<D>,
  ): DynamicModule {
    const paths: DocPaths = { ...DEFAULT_PATHS };

    const configured: DynamicModule = {
      module: OpenApiModule,
      imports: [options.root],
      // The generated document, so an app can read `warnings` or serve the JSON
      // itself. This module wraps the app's root rather than being imported by it,
      // so the export is what makes `app.get(OpenApiExplorer)` resolve.
      exports: [OpenApiExplorer],
      controllers: [buildController(paths)],
      providers: [
        provide(OpenApiExplorer, {
          useFactory: async (...deps) => {
            const info = await options.useFactory(...deps);
            Object.assign(paths, pathsFrom(info));
            return new OpenApiExplorer(
              await generateDocument(describeRoutes(configured), info),
              paths.json,
              paths.ui,
              paths.uiOptions,
            );
          },
          inject: options.inject ?? ([] as unknown as D),
        }),
      ],
    };

    return configured;
  }
}
