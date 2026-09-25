import { joinPath } from '@dunx/http/internal';
import type { GeneratedDocument } from './generate.js';
import { withPrefix } from './mount.js';
import type { DocsRenderer, VersionLink } from './renderer.js';
import type { OpenApiDocument } from './types.js';
import type { VersionedDocuments } from './versions.js';

/**
 * The generated document, plus the two renderings of it the controller serves. Built
 * once at boot - the request path only serialises - and keyed by mount prefix,
 * because `setGlobalPrefix()` is applied after the container is built.
 *
 * Under header or media-type versioning there is one document per version; a
 * `version` argument names one, and omitting it gives the primary one.
 */
export class OpenApiExplorer {
  /** Every schema that degraded. Readable straight after `HttpFactory.create()`. */
  readonly warnings: readonly string[];
  readonly #base: GeneratedDocument;
  readonly #versions: VersionedDocuments | undefined;
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
    versions?: VersionedDocuments,
  ) {
    this.#base = generated;
    this.#versions = versions;
    this.warnings = [
      ...new Set(
        [...(versions?.documents.values() ?? [generated])].flatMap(
          (each) => each.warnings,
        ),
      ),
    ];
    this.#jsonPath = jsonPath;
    this.#uiPath = uiPath;
    this.#renderer = renderer;
  }

  /** Each version with a document of its own, in order. Empty for one document. */
  get versions(): readonly string[] {
    return [...(this.#versions?.documents.keys() ?? [])];
  }

  /** A version this explorer has no document for gets the primary one. */
  document(prefix = '', version?: string): OpenApiDocument {
    const key = `${prefix}\n${version ?? ''}`;
    const cached = this.#documents.get(key);
    if (cached !== undefined) return cached;
    const generated =
      (version === undefined
        ? undefined
        : this.#versions?.documents.get(version)) ?? this.#base;
    const document = withPrefix(
      generated.document,
      prefix,
      generated.absolutePaths,
    );
    this.#documents.set(key, document);
    return document;
  }

  json(prefix = '', version?: string): string {
    const key = `${prefix}\n${version ?? ''}`;
    const cached = this.#json.get(key);
    if (cached !== undefined) return cached;
    const serialised = JSON.stringify(this.document(prefix, version));
    this.#json.set(key, serialised);
    return serialised;
  }

  /**
   * The page, built on the first request for a given mount prefix and cached.
   *
   * The renderer resolves its own assets here rather than at boot, so an app
   * serving only `/openapi.json` never looks them up and a missing optional peer
   * surfaces as this route failing rather than as everyone's boot error.
   */
  page(prefix = '', version?: string): Promise<string> {
    const key = `${prefix}\n${version ?? ''}`;
    const cached = this.#pages.get(key);
    if (cached !== undefined) return cached;

    // The promise, not its value: a cold page load asks for the page and its
    // assets at once, and a value written after the await renders them all.
    const rendering = this.#render(prefix, version);
    this.#pages.set(key, rendering);
    // Eviction after the `set`, not inside `#render`: a synchronous throw runs
    // `#render`'s body before `page()` caches, so a `catch` in there deleted
    // nothing and the rejection stayed. The identity check keeps a retry's entry.
    void rendering.catch(() => {
      if (this.#pages.get(key) === rendering) this.#pages.delete(key);
    });
    return rendering;
  }

  /** Async so a missing renderer rejects rather than throwing out of `page()`. */
  async #render(prefix: string, version: string | undefined): Promise<string> {
    const query = (name: string): string =>
      `?version=${encodeURIComponent(name)}`;
    const jsonHref = joinPath(prefix, this.#jsonPath);
    const mountedAt = joinPath(prefix, this.#uiPath);
    const shown = version ?? this.#versions?.primary;
    const versions: readonly VersionLink[] = this.versions.map((name) => ({
      name,
      href: `${mountedAt}${query(name)}`,
      current: name === shown,
    }));
    return this.#ui().page(this.document(prefix, version), {
      jsonHref:
        version === undefined ? jsonHref : `${jsonHref}${query(version)}`,
      warnings: this.warnings,
      mountedAt,
      ...(versions.length === 0 ? {} : { versions }),
    });
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
