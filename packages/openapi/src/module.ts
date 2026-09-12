import {
  provide,
  type Deps,
  type DynamicModule,
  type AsyncModuleConfig,
  type ModuleRef,
} from '@dunx/core';
import { buildController, type DocPaths } from './controller.js';
import { describeRoutes } from './discover.js';
import { OpenApiExplorer } from './explorer.js';
import { generateDocument, type DocumentInfo } from './generate.js';
import type { DocsRenderer } from './renderer.js';

/** Everything about the document itself, which is everything a factory can produce. */
export interface OpenApiInfo extends DocumentInfo {
  /** Where the HTML page is mounted. Default `/docs`. */
  readonly path?: string;
  /** Where the document is mounted. Default `/openapi.json`. */
  readonly jsonPath?: string;
}

/**
 * The documentation UI, if there is one. Absent means the module serves the
 * document and nothing else: no page route, no asset route.
 *
 * It sits outside `forRootAsync`'s factory for the same reason `root` does - the
 * controller declares its routes before a container exists to run one - so it is
 * a constructed renderer rather than a name to resolve:
 *
 * ```ts
 * import { SwaggerRenderer } from '@dunx/openapi/swagger';
 * import { ScalarRenderer } from '@dunx/openapi/scalar';
 * ```
 */
interface RendererOption {
  readonly renderer?: DocsRenderer;
}

export interface OpenApiOptions extends OpenApiInfo, RendererOption {
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
export interface OpenApiAsyncOptions<D extends Deps>
  extends AsyncModuleConfig<OpenApiInfo, D>, RendererOption {
  readonly root: ModuleRef;
}

const DEFAULT_PATHS: Readonly<DocPaths> = Object.freeze({
  json: '/openapi.json',
  ui: '/docs',
});

const pathsFrom = (info: OpenApiInfo): DocPaths => ({
  json: info.jsonPath ?? DEFAULT_PATHS.json,
  ui: info.path ?? DEFAULT_PATHS.ui,
});

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
      controllers: [buildController(paths, options.renderer)],
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
              options.renderer,
            ),
        }),
      ],
    };

    return configured;
  }

  /**
   * The same module, with every field produced by a factory that may await and
   * inject:
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
   * The mount paths come out of the factory too. The controller's routes are
   * declared with path thunks and discovery runs after every provider has
   * settled, so both the document and the served table read the filled values.
   */
  static forRootAsync<const D extends Deps>(
    options: OpenApiAsyncOptions<D>,
  ): DynamicModule {
    const paths: DocPaths = { ...DEFAULT_PATHS };

    const configured: DynamicModule = {
      module: OpenApiModule,
      // The root this module wraps, plus whatever the caller's factory needs:
      // this module is its own scope, so a provider the root merely imports is
      // not in reach of the factory unless the root exports it.
      imports: [options.root, ...(options.imports ?? [])],
      // The generated document, so an app can read `warnings` or serve the JSON
      // itself. This module wraps the app's root rather than being imported by it,
      // so the export is what makes `app.get(OpenApiExplorer)` resolve.
      exports: [OpenApiExplorer],
      controllers: [buildController(paths, options.renderer)],
      providers: [
        provide(OpenApiExplorer, {
          useFactory: async (...deps) => {
            const info = await options.useFactory(...deps);
            Object.assign(paths, pathsFrom(info));
            return new OpenApiExplorer(
              await generateDocument(describeRoutes(configured), info),
              paths.json,
              paths.ui,
              options.renderer,
            );
          },
          inject: options.inject ?? ([] as unknown as D),
        }),
      ],
    };

    return configured;
  }
}
