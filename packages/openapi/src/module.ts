import {
  inject,
  provide,
  type DynamicModule,
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

export interface OpenApiOptions extends DocumentInfo {
  /**
   * The module graph to document. It is also what gets imported, so this configured
   * module is what you hand `HttpFactory.create()` — one root, named once.
   */
  readonly root: ModuleRef;
  /** Where the HTML page is mounted. Default `/docs`. */
  readonly path?: string;
  /** Where the document is mounted. Default `/openapi.json`. */
  readonly jsonPath?: string;
}

/**
 * The generated document, plus the two renderings of it the controller serves. Built
 * once at boot — the request path only serialises — and keyed by mount prefix,
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
  readonly json: string;
  readonly ui: string;
}

/**
 * The controller is built per `forRoot` call because its paths are configuration and
 * a decorator's arguments are evaluated when the class definition is — which, for a
 * class declared in a function, is when the function runs. So `@Get(paths.json)` is
 * an ordinary decorator reading an ordinary closure variable, and the routes are
 * discovered, guarded, CORS-wrapped and middleware-wrapped exactly like any other
 * controller's. Nothing is mounted behind the app's back.
 */
const buildController = (paths: DocPaths) => {
  @Controller()
  class OpenApiController {
    // inject() in a field initializer, not a constructor parameter: this package
    // works with or without the @dunx/transform preload.
    readonly #explorer = inject(OpenApiExplorer);

    @Public()
    @Get(paths.json)
    document(input: Input<RouteSchemas>): Response {
      return new Response(
        this.#explorer.json(this.#prefix(input, paths.json)),
        {
          headers: { 'content-type': 'application/json; charset=utf-8' },
        },
      );
    }

    @Public()
    @Get(paths.ui)
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
   * The factory is async, so the whole document — every schema conversion included —
   * is settled before the first constructor runs and `warnings` is readable at boot.
   */
  static forRoot(options: OpenApiOptions): DynamicModule {
    const paths: DocPaths = {
      json: options.jsonPath ?? '/openapi.json',
      ui: options.path ?? '/docs',
    };

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
}
