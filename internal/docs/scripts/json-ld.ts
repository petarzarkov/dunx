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
 * the result is drawn, and the breadcrumb is what puts `dunx.win > Releases`
 * under the title instead of a bare URL.
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
   * Required, so a crumb cannot reach {@link breadcrumbs} without one. Google
   * treats a `ListItem` with no `item` as a critical Breadcrumbs error on every
   * position but the last, and it reported one against dunx.win: `/guide` and
   * `/api` have no page of their own, and the section crumb was being published
   * with a name and nothing to click. A section like that is left out of the
   * trail now rather than published without a URL.
   */
  readonly path: string;
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
 * The first path segments the site serves, and the crumb each one contributes.
 *
 * `pagesOf` writes `/releases`, but there is no `/guide` or `/api` file and
 * `_redirects` carries no catch-all, so both answer with `404.html`. A crumb
 * linking one would put a dead URL in the structured data, and a crumb naming
 * one without a URL is the error Google raised. Neither contributes a crumb:
 * `Record<string, Crumb | undefined>` and no entry is how a known section says
 * it has no page.
 */
const SECTIONS: Record<string, Crumb | undefined> = {
  guide: undefined,
  api: undefined,
  releases: { name: 'Releases', path: '/releases' },
};

/**
 * A page title as a breadcrumb label: `Controllers | dunx` is the `<title>`, and
 * a trail reading `dunx > Controllers | dunx` says the site name twice. Only the
 * last ` | ` segment goes, so `@dunx/http` keeps its slash and `dunx 3.4.1 |
 * Releases` becomes `dunx 3.4.1`.
 */
const label = (title: string): string =>
  title.replace(/\s*\|\s*[^|]+$/, '').trim() || title;

/**
 * `/releases/3.4.1` becomes `dunx > Releases > 3.4.1`, and
 * `/guide/controllers` becomes `dunx > Controllers`, because the guide has no
 * index page to point the middle crumb at.
 *
 * Built from the path rather than passed in, so a route added to `pagesOf` gets
 * a trail without a second list to update.
 */
export const crumbsOf = (path: string, title: string): Crumb[] => {
  const segments = path.split('/').filter((segment) => segment !== '');
  const first = segments[0];
  if (first === undefined || !Object.hasOwn(SECTIONS, first)) return [];

  const section = SECTIONS[first];

  // A one-segment path is the section's own page, and having been handed to this
  // function at all is what says it was rendered.
  if (segments.length === 1) {
    return section === undefined ? [] : [{ name: section.name, path }];
  }

  const leaf: Crumb = { name: label(title), path };
  return section === undefined ? [leaf] : [section, leaf];
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
      item: `${entity.origin}${crumb.path}`,
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
