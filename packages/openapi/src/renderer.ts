import type { OpenApiDocument } from './types.js';

/** One entry of the version bar a per-version page shows. */
export interface VersionLink {
  readonly name: string;
  /** The page for that version. */
  readonly href: string;
  /** Whether this page shows it. */
  readonly current: boolean;
}

/** Where the page is served, which is what its hrefs depend on. */
export interface PageOptions {
  /** Where the JSON document is served, so the page can link to it. */
  readonly jsonHref: string;
  /** Every schema that degraded while the document was generated. */
  readonly warnings: readonly string[];
  /** Where the page is mounted, which is where its assets hang off. */
  readonly mountedAt: string;
  /** Header or media-type versioning only: one link per version's page. */
  readonly versions?: readonly VersionLink[];
}

/**
 * What `OpenApiModule` needs from a documentation UI. dunx ships `SwaggerRenderer`
 * behind `@dunx/openapi/swagger` and `ScalarRenderer` behind `./scalar`, each with
 * its own optional peer. One of your own is this class plus a `PackageAssets`.
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
