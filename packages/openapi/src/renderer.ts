import type { OpenApiDocument } from './types.js';

/** Where the page is being served, which is everything its hrefs depend on. */
export interface PageOptions {
  /** Where the JSON document is served, so the page can link to it. */
  readonly jsonHref: string;
  /** Every schema that degraded while the document was generated. */
  readonly warnings: readonly string[];
  /** Where the page itself is mounted, which is where its assets hang off. */
  readonly mountedAt: string;
}

/**
 * What `OpenApiModule` needs from a documentation UI. dunx ships two,
 * `SwaggerRenderer` behind `@dunx/openapi/swagger` and `ScalarRenderer` behind
 * `@dunx/openapi/scalar`, each with its own optional peer dependency.
 *
 * A renderer of your own is this class plus a `PackageAssets`: nothing here knows
 * which library is underneath.
 */
export abstract class DocsRenderer {
  /** The whole page, given the generated document and where it is mounted. */
  abstract page(
    document: OpenApiDocument,
    options: PageOptions,
  ): Promise<string>;

  /** One file by the name the page linked. Anything else answers 404. */
  abstract asset(name: string): Promise<Response>;
}
