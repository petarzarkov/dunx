import {
  inject,
  provide,
  type Deps,
  type DynamicModule,
  type FactoryProvider,
  type ModuleRef,
} from '@dunx/core';
import {
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
import { renderPage } from './html.js';
import { mountPrefix, withPrefix } from './mount.js';
import type { OpenApiDocument } from './types.js';

/** Everything about the document itself, which is everything a factory can produce. */
export interface OpenApiInfo extends DocumentInfo {
  /** Where the HTML page is mounted. Default `/docs`. */
  readonly path?: string;
  /** Where the document is mounted. Default `/openapi.json`. */
  readonly jsonPath?: string;
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
  readonly #jsonPath: string;
  readonly #documents = new Map<string, OpenApiDocument>();
  readonly #json = new Map<string, string>();
  readonly #pages = new Map<string, string>();

  constructor(generated: GeneratedDocument, jsonPath: string) {
    this.#base = generated.document;
    this.warnings = generated.warnings;
    this.#jsonPath = jsonPath;
  }

  document(prefix = ''): OpenApiDocument {
    const cached = this.#documents.get(prefix);
    if (cached !== undefined) return cached;
    const document = withPrefix(this.#base, prefix);
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

  page(prefix = ''): string {
    const cached = this.#pages.get(prefix);
    if (cached !== undefined) return cached;
    const html = renderPage(this.document(prefix), {
      jsonHref: joinPath(prefix, this.#jsonPath),
      warnings: this.warnings,
    });
    this.#pages.set(prefix, html);
    return html;
  }
}

interface DocPaths {
  json: string;
  ui: string;
}

const DEFAULT_PATHS: Readonly<DocPaths> = Object.freeze({
  json: '/openapi.json',
  ui: '/docs',
});

const pathsFrom = (info: OpenApiInfo): DocPaths => ({
  json: info.jsonPath ?? DEFAULT_PATHS.json,
  ui: info.path ?? DEFAULT_PATHS.ui,
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
    page(input: Input<RouteSchemas>): Response {
      return new Response(this.#explorer.page(this.#prefix(input, paths.ui)), {
        headers: { 'content-type': 'text/html; charset=utf-8' },
      });
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
      controllers: [buildController(paths)],
      providers: [
        provide(OpenApiExplorer, {
          useFactory: async (...deps) => {
            const info = await options.useFactory(...deps);
            Object.assign(paths, pathsFrom(info));
            return new OpenApiExplorer(
              await generateDocument(describeRoutes(configured), info),
              paths.json,
            );
          },
          inject: options.inject ?? ([] as unknown as D),
        }),
      ],
    };

    return configured;
  }
}
