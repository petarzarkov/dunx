import { joinPath } from '@dunx/http/internal';
import type { GeneratedDocument } from './generate.js';
import { withPrefix } from './mount.js';
import type { DocsRenderer } from './renderer.js';
import type { OpenApiDocument } from './types.js';

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
  readonly #renderer: DocsRenderer | undefined;
  readonly #documents = new Map<string, OpenApiDocument>();
  readonly #json = new Map<string, string>();
  readonly #pages = new Map<string, Promise<string>>();

  constructor(
    generated: GeneratedDocument,
    jsonPath: string,
    uiPath: string,
    renderer?: DocsRenderer,
  ) {
    this.#base = generated.document;
    this.#absolutePaths = generated.absolutePaths;
    this.warnings = generated.warnings;
    this.#jsonPath = jsonPath;
    this.#uiPath = uiPath;
    this.#renderer = renderer;
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
   * The renderer resolves its own assets here rather than at boot, so an app
   * serving only `/openapi.json` never looks them up and a missing optional peer
   * surfaces as this route failing rather than as everyone's boot error.
   */
  page(prefix = ''): Promise<string> {
    const cached = this.#pages.get(prefix);
    if (cached !== undefined) return cached;

    // The promise, not its value, for the reason `PackageAssets.resolve` caches
    // one: a cold page load asks for the page and its assets at once, and a
    // value written after the await lets every one of them render it again.
    const rendering = this.#render(prefix);
    this.#pages.set(prefix, rendering);
    return rendering;
  }

  /**
   * Async so that `#ui()` refusing a missing renderer rejects rather than
   * throwing synchronously out of `page()`, and so a failure evicts itself - a
   * cached rejection would leave the route broken for the process's life.
   */
  async #render(prefix: string): Promise<string> {
    try {
      return await this.#ui().page(this.document(prefix), {
        jsonHref: joinPath(prefix, this.#jsonPath),
        warnings: this.warnings,
        mountedAt: joinPath(prefix, this.#uiPath),
      });
    } catch (error) {
      this.#pages.delete(prefix);
      throw error;
    }
  }

  /** One file the page linked, straight off disk. Any other name is a 404. */
  async asset(name: string): Promise<Response> {
    return this.#ui().asset(name);
  }

  #ui(): DocsRenderer {
    if (this.#renderer === undefined) {
      throw new Error(
        'No renderer is configured, so @dunx/openapi serves the document alone. ' +
          "Pass one: `renderer: new SwaggerRenderer()` from '@dunx/openapi/swagger', " +
          "or `new ScalarRenderer()` from '@dunx/openapi/scalar'.",
      );
    }
    return this.#renderer;
  }
}
