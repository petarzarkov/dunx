import {
  compareVersions,
  type DiscoveredRoute,
  type RouteVersioning,
} from '@dunx/http/internal';
import {
  generateDocument,
  type DocumentInfo,
  type GeneratedDocument,
} from './generate.js';

/** The document per version, when one document cannot hold them all. */
export interface VersionedDocuments {
  /** The one served without `?version=`: `defaultVersion`, else the highest. */
  readonly primary: string;
  readonly documents: ReadonlyMap<string, GeneratedDocument>;
}

export interface GeneratedDocuments {
  /** What a request naming no version is served. */
  readonly document: GeneratedDocument;
  /** Absent under URI versioning, or with no versioned route. */
  readonly versions?: VersionedDocuments;
}

/**
 * One document, unless the app versions by header or media type. Then every
 * version shares its paths with the others, and OpenAPI 3.1 allows one
 * operation per path and method, so each version is a document of its own
 * holding that version's routes and every unversioned one.
 */
export const generateDocuments = async (
  routes: readonly DiscoveredRoute[],
  info: DocumentInfo,
  versioning: RouteVersioning,
): Promise<GeneratedDocuments> => {
  const versions = [
    ...new Set(routes.flatMap((route) => route.version ?? [])),
  ].sort(compareVersions);
  if (versioning.header === undefined || versions.length === 0) {
    return { document: await generateDocument(routes, info) };
  }

  // `Accept` is not documented: OpenAPI 3.1 ignores a header parameter by that
  // name.
  const header =
    versioning.type === 'header' && versioning.header !== undefined
      ? { name: versioning.header, defaults: versioning.defaults }
      : undefined;
  const documents = new Map<string, GeneratedDocument>();
  for (const version of versions) {
    const own = routes.filter(
      (route) => route.version === undefined || route.version === version,
    );
    documents.set(version, await generateDocument(own, info, header));
  }
  const primary =
    versioning.defaults.find((version) => documents.has(version)) ??
    versions.at(-1)!;
  return {
    document: documents.get(primary)!,
    versions: { primary, documents },
  };
};
