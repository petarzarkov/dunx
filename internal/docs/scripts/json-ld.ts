/**
 * The structured-data block for one page.
 *
 * Two searches for the framework by name returned other people's Bun
 * frameworks and a suggestion that the name might be spelled differently, which
 * is what an unrecognised entity looks like from the outside. `name`,
 * `applicationCategory` and a `codeRepository` pointing at a repository Google
 * already indexes are the cheapest way to say that `dunx` is a thing rather
 * than a typo.
 *
 * A guide or a reference page gets `TechArticle` plus the breadcrumb trail its
 * URL already implies. Neither is a ranking factor on its own; both change how
 * the result is drawn, and the breadcrumb is what puts `dunx.win > Guide` under
 * the title instead of a bare URL.
 */

export interface Entity {
  readonly origin: string;
  readonly repoUrl: string;
  /** The latest release, when the model carries one. */
  readonly version: string | null;
}

export interface Crumb {
  readonly name: string;
  /**
   * Absent when the section has no page of its own, which is what keeps a
   * breadcrumb from publishing a URL that answers 404.
   */
  readonly path?: string;
}

/**
 * `<` is escaped so the payload cannot close the script element that carries
 * it. JSON has no other way out of a `<script>` block, and a package
 * description holding `Bun.serve<T>` is not hypothetical.
 */
const embed = (value: unknown): string =>
  JSON.stringify(value).replace(/</g, '\\u003c');

const softwareApplication = (
  entity: Entity,
  description: string,
): Record<string, unknown> => ({
  '@context': 'https://schema.org',
  '@type': 'SoftwareApplication',
  name: 'dunx',
  description,
  url: `${entity.origin}/`,
  applicationCategory: 'DeveloperApplication',
  operatingSystem: 'Linux, macOS, Windows',
  codeRepository: entity.repoUrl,
  programmingLanguage: 'TypeScript',
  runtimePlatform: 'Bun',
  ...(entity.version === null ? {} : { softwareVersion: entity.version }),
  // A framework published to npm under a licence, which is what makes the free
  // price honest rather than a marketing field.
  license: 'https://opensource.org/license/mit',
  offers: {
    '@type': 'Offer',
    price: '0',
    priceCurrency: 'USD',
  },
});

const techArticle = (
  entity: Entity,
  title: string,
  description: string,
  path: string,
): Record<string, unknown> => ({
  '@context': 'https://schema.org',
  '@type': 'TechArticle',
  headline: title,
  description,
  url: `${entity.origin}${path}`,
  isPartOf: {
    '@type': 'WebSite',
    name: 'dunx',
    url: `${entity.origin}/`,
  },
});

/**
 * The label for a first path segment, and whether that section is a page.
 *
 * `pagesOf` writes `/releases`, but there is no `/guide` or `/api` file and
 * `_redirects` carries no catch-all, so both answer with `404.html`. A crumb
 * linking one would put a dead URL in the structured data.
 */
const SECTIONS: Record<
  string,
  { readonly name: string; readonly routable: boolean }
> = {
  guide: { name: 'Guide', routable: false },
  api: { name: 'Reference', routable: false },
  releases: { name: 'Releases', routable: true },
};

/**
 * `/guide/controllers` becomes `dunx > Guide > Controllers`, with `Guide`
 * carrying no link.
 *
 * Built from the path rather than passed in, so a route added to `pagesOf` gets
 * a trail without a second list to update.
 */
export const crumbsOf = (path: string, title: string): Crumb[] => {
  const segments = path.split('/').filter((segment) => segment !== '');
  const first = segments[0];
  if (first === undefined) return [];

  const section = SECTIONS[first];
  if (section === undefined) return [];

  // A one-segment path is the section's own page, and having been handed to this
  // function at all is what says it was rendered.
  if (segments.length === 1) return [{ name: section.name, path }];

  const parent: Crumb = section.routable
    ? { name: section.name, path: `/${first}` }
    : { name: section.name };

  return [parent, { name: title, path }];
};

const breadcrumbs = (
  entity: Entity,
  crumbs: readonly Crumb[],
): Record<string, unknown> => ({
  '@context': 'https://schema.org',
  '@type': 'BreadcrumbList',
  itemListElement: [
    {
      '@type': 'ListItem',
      position: 1,
      name: 'dunx',
      item: `${entity.origin}/`,
    },
    ...crumbs.map((crumb, index) => ({
      '@type': 'ListItem',
      position: index + 2,
      name: crumb.name,
      // schema.org allows a ListItem with a name and no `item`, which is the
      // spelling for a step in the trail that is not itself a page.
      ...(crumb.path === undefined
        ? {}
        : { item: `${entity.origin}${crumb.path}` }),
    })),
  ],
});

/**
 * The JSON-LD payloads for one page, serialized but not wrapped.
 *
 * `entry-server.tsx` puts each in a `<script type="application/ld+json">` head
 * element, so the wrapping belongs to whatever is building the head rather than
 * here.
 *
 * The landing page describes the software; every other page describes itself and
 * its position in the site. Nothing emits both, because two `SoftwareApplication`
 * nodes on one origin is how a site ends up with the wrong one chosen.
 */
export const jsonLdFor = (options: {
  readonly entity: Entity;
  readonly path: string;
  readonly title: string;
  readonly description: string;
  readonly kind: 'article' | 'website';
}): string[] => {
  const { entity, path, title, description, kind } = options;

  if (path === '/') {
    return [embed(softwareApplication(entity, description))];
  }

  const crumbs = crumbsOf(path, title);
  const blocks: unknown[] = [];
  if (kind === 'article') {
    blocks.push(techArticle(entity, title, description, path));
  }
  if (crumbs.length > 0) {
    blocks.push(breadcrumbs(entity, crumbs));
  }

  return blocks.map(embed);
};
