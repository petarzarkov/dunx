import { describe, expect, test } from 'bun:test';
import { loadGuide, loadPackage, loadReleases, site } from './data';
import { RouteKind } from './router';

/**
 * Routes that are one page with no slug, so a link to one needs nothing checked
 * beyond the kind. Taken from `RouteKind` rather than written out: the literal
 * list held `bench`, which has never been a route - `RouteKind.Bench` is
 * `benchmarks` - so a markdown link to the benchmarks page was reported as an
 * offender and the entry protected nothing.
 */
const SLUGLESS: ReadonlySet<string> = new Set([
  '',
  RouteKind.Bench,
  RouteKind.Coverage,
]);

/**
 * Every internal link on the site, resolved against what the site actually
 * serves.
 *
 * This exists because two classes of broken link shipped. A bare `#anchor` is
 * read as a route by a hash router, so in-page links navigated away from the page
 * they were written on; and `docs/ARCHITECTURE.md` being split moved a dozen
 * section anchors without moving the links that pointed at them. Both were found
 * by a reader, not by a check.
 */
const pages = async (): Promise<
  { slug: string; html: string; headings: readonly string[] }[]
> => {
  const out: { slug: string; html: string; headings: readonly string[] }[] = [];
  for (const guide of site.guides) {
    const body = await loadGuide(guide.slug);
    out.push({
      slug: guide.slug,
      html: body?.html ?? '',
      headings: guide.headings.map((heading) => heading.id),
    });
  }
  return out;
};

const packagePages = async (): Promise<{ slug: string; html: string }[]> => {
  const out: { slug: string; html: string }[] = [];
  for (const pkg of site.packages) {
    const body = await loadPackage(pkg.dir);
    out.push({ slug: pkg.dir, html: body?.readme ?? '' });
  }
  return out;
};

const hrefs = (html: string): string[] =>
  [...html.matchAll(/href="([^"]+)"/g)].flatMap((match) =>
    match[1] === undefined ? [] : [match[1]],
  );

const internal = (href: string): boolean =>
  href.startsWith('/') && !href.startsWith('//');

describe('internal links', () => {
  test('no link is a bare fragment', async () => {
    const offenders: string[] = [];
    for (const page of [...(await pages()), ...(await packagePages())]) {
      for (const href of hrefs(page.html)) {
        // A bare `#id` would scroll natively, but a guide body is a separate
        // chunk that arrives after the document does, so the fragment resolves
        // against a page that has not rendered yet and lands nowhere. `?h=` is
        // retried across frames by `useScrollTo`, which is why every anchor on
        // the site is written that way.
        if (href.startsWith('#')) {
          offenders.push(`${page.slug}: ${href}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  test('every in-site link points at a page that exists', async () => {
    const guideSlugs = new Set(site.guides.map((guide) => guide.slug));
    const packageDirs = new Set(site.packages.map((pkg) => pkg.dir));
    const versions = new Set(
      ((await loadReleases()) ?? []).map((release) => release.version),
    );
    const offenders: string[] = [];

    for (const page of [...(await pages()), ...(await packagePages())]) {
      for (const href of hrefs(page.html)) {
        if (!internal(href)) continue;
        const [route = ''] = href.slice(1).split('?');
        const [kind = '', slug = ''] = route.split('/');

        if (SLUGLESS.has(kind)) continue;
        if (kind === 'guide' && guideSlugs.has(slug)) continue;
        if (kind === 'api' && packageDirs.has(slug)) continue;
        // `releases` is both a page and a slugged route now, so it is checked
        // rather than waved through: this catches a page citing a version that
        // was never released.
        if (kind === RouteKind.Releases && slug === '') continue;
        if (kind === RouteKind.Releases && versions.has(slug.replace(/^v/, '')))
          continue;
        offenders.push(`${page.slug}: ${href}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  /*
   * The `?h=` half. A link may resolve to a real page and still land at the top of
   * it, which is what happened to every anchor into the architecture record after
   * it was split into twelve files.
   */
  test('every ?h= anchor names a heading on the page it targets', async () => {
    const all = await pages();
    const headingsBySlug = new Map(
      all.map((page) => [page.slug, new Set(page.headings)]),
    );
    const offenders: string[] = [];

    for (const page of [...all, ...(await packagePages())]) {
      for (const href of hrefs(page.html)) {
        if (!internal(href) || !href.includes('?h=')) continue;
        const [route = '', query = ''] = href.slice(1).split('?');
        const [kind = '', slug = ''] = route.split('/');
        if (kind !== 'guide') continue;

        const anchor = new URLSearchParams(query).get('h');
        const known = headingsBySlug.get(slug);
        // A page with fewer than three headings renders no contents list, but its
        // ids are still in the index, so this stays checkable either way.
        if (anchor !== null && known && !known.has(anchor)) {
          offenders.push(`${page.slug} -> /guide/${slug}?h=${anchor}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
