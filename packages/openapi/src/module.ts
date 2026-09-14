import {
  provide,
  type Deps,
  type DynamicModule,
  type AsyncModuleConfig,
  type ModuleRef,
} from '@dunx/core';
import type { Authorize } from '@dunx/http';
import { buildController, type DocMount } from './controller.js';
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
  /**
   * Who may see the explorer: the document, the page and the page's own assets,
   * one decision covering all three. `@dunx/dashboard` takes the same
   * {@link Authorize}. No default and no boot warning either, unlike the
   * dashboard: a public API's document is published to be read.
   */
  readonly authorize?: Authorize;
}

/**
 * The documentation UI, if there is one. Absent serves the document alone. It
 * sits outside `forRootAsync`'s factory for the reason `root` does, so it is a
 * constructed `SwaggerRenderer` or `ScalarRenderer` rather than a name.
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
 * `forRootAsync`'s argument: the root, plus the factory for everything else.
 * `root` stays here because it is a module reference, and the graph has to exist
 * before the container that would run the factory.
 */
export interface OpenApiAsyncOptions<D extends Deps>
  extends AsyncModuleConfig<OpenApiInfo, D>, RendererOption {
  readonly root: ModuleRef;
}

const DEFAULT_MOUNT: Readonly<DocMount> = Object.freeze({
  json: '/openapi.json',
  ui: '/docs',
  authorize: undefined,
});

const mountFrom = (info: OpenApiInfo): DocMount => ({
  json: info.jsonPath ?? DEFAULT_MOUNT.json,
  ui: info.path ?? DEFAULT_MOUNT.ui,
  authorize: info.authorize,
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
    const mount = mountFrom(options);

    const configured: DynamicModule = {
      module: OpenApiModule,
      imports: [options.root],
      // The generated document, so an app can read `warnings` or serve the JSON
      // itself. This module wraps the app's root rather than being imported by it,
      // so the export is what makes `app.get(OpenApiExplorer)` resolve.
      exports: [OpenApiExplorer],
      controllers: [buildController(mount, options.renderer)],
      providers: [
        provide(OpenApiExplorer, {
          // `configured` includes the controller above, so discovery reaches the
          // documentation routes. They are `@ApiHidden()`, so they are reached
          // and then dropped rather than never declared.
          useFactory: async () =>
            new OpenApiExplorer(
              await generateDocument(describeRoutes(configured), options),
              mount.json,
              mount.ui,
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
   * The mount paths come out of the factory too, and so does `authorize`, which
   * is the only way to close over an `Auth` the container owns. The controller's
   * routes are declared with path thunks and discovery runs after every provider
   * has settled, so both the document and the served table read filled values.
   */
  static forRootAsync<const D extends Deps>(
    options: OpenApiAsyncOptions<D>,
  ): DynamicModule {
    const mount: DocMount = { ...DEFAULT_MOUNT };

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
      controllers: [buildController(mount, options.renderer)],
      providers: [
        provide(OpenApiExplorer, {
          useFactory: async (...deps) => {
            const info = await options.useFactory(...deps);
            Object.assign(mount, mountFrom(info));
            return new OpenApiExplorer(
              await generateDocument(describeRoutes(configured), info),
              mount.json,
              mount.ui,
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
