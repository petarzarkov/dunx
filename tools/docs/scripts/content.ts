import type { GuidePage } from './extract/model';

const REPO_BLOB = 'https://github.com/petarzarkov/dunx/blob/main';

export const slugify = (text: string): string =>
  text
    .toLowerCase()
    .replace(/`/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

const decode = (html: string): string =>
  html
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .trim();

export interface LinkTargets {
  /** Markdown filename (`ARCHITECTURE.md`) -> in-site route. */
  readonly guides: ReadonlyMap<string, string>;
  /** Package directory (`core`) -> in-site route. */
  readonly packages: ReadonlyMap<string, string>;
}

/**
 * Rewrites the links the source markdown was written with. A doc that says
 * `./ARCHITECTURE.md` must land on the guide page here, and anything the site
 * does not host at all has to become an absolute link back to GitHub rather
 * than a dead relative one.
 */
export const rewriteHref = (href: string, targets: LinkTargets): string => {
  if (/^(?:[a-z]+:|#|\/\/)/i.test(href)) return href;

  const [path = '', hash] = href.split('#');
  const suffix = hash ? `#${hash}` : '';
  if (path === '') return href;

  const base = path.replace(/^(?:\.\/|\.\.\/)+/, '');

  const guide =
    targets.guides.get(base) ?? targets.guides.get(base.replace(/^docs\//, ''));
  if (guide) return suffix ? `${guide}?h=${hash}` : guide;

  const pkg = targets.packages.get(
    base.replace(/^packages\//, '').replace(/\/$/, ''),
  );
  if (pkg && base.startsWith('packages/')) return pkg;

  return `${REPO_BLOB}/${base}${suffix}`;
};

/**
 * Sections a README carries for someone working **in this repository**, which a
 * reader of the docs site is not. Matched on the `##` heading's slug with a `-`
 * word boundary, so `## Install it as a devDependency` goes with `## Install`.
 *
 * The line is: drop a section that documents the repository rather than the
 * package - how to install from source, how to contribute, what the licence is,
 * how the monorepo is laid out - or that the site already generates for itself,
 * which is only the package index. Everything else reaches the page, and an
 * author decides which side a section falls on purely by naming it. The list is
 * published in `tools/docs/README.md` so it is predictable without reading this
 * file.
 */
export const EXCLUDED_SECTIONS: readonly string[] = [
  'adding-a-new-package',
  'building',
  'commit-convention',
  'contributing',
  'development',
  'install',
  'installation',
  'licence',
  'license',
  'packages',
  'project-structure',
  'scripts',
  'versioning',
];

const isExcluded = (heading: string): boolean => {
  const slug = slugify(heading);
  return EXCLUDED_SECTIONS.some(
    (name) => slug === name || slug.startsWith(`${name}-`),
  );
};

const FENCE = /^ {0,3}(?:```|~~~)/;
const ATX = /^ {0,3}(#{1,2})\s+(.+?)\s*#*\s*$/;
/** The centered title-and-badges block every README opens with. The site
 * renders its own title, and a row of shields is not documentation. */
const CENTERED_OPEN = /^ {0,3}<div align="center">/;
const CENTERED_CLOSE = /^ {0,3}<\/div>/;

/**
 * The part of a README the site renders. Applied to READMEs only - the guides
 * under `docs/` *are* repository documentation, so nothing is dropped from
 * them.
 *
 * Line-oriented rather than run over the produced HTML, so heading ids and link
 * rewriting only ever see kept content - and fenced code is tracked, because
 * `packages/transform/README.md` opens a block with `# bunfig.toml` in it.
 */
export const siteMarkdown = (markdown: string): string => {
  const kept: string[] = [];
  let fenced = false;
  let dropping = false;
  let centered = false;

  for (const line of markdown.split('\n')) {
    if (FENCE.test(line)) fenced = !fenced;

    if (!fenced) {
      if (centered) {
        centered = !CENTERED_CLOSE.test(line);
        continue;
      }
      if (CENTERED_OPEN.test(line)) {
        centered = true;
        continue;
      }

      const heading = ATX.exec(line);
      if (heading) {
        dropping = heading[1]?.length === 2 && isExcluded(heading[2] ?? '');
      }
    }

    if (!dropping) kept.push(line);
  }

  return `${kept
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()}\n`;
};

const HEADING = /<h([1-6])>([\s\S]*?)<\/h\1>/g;
const ANCHOR = /<a href="([^"]*)"/g;
/** Every page renders its own title, so the document's opening `# Heading`
 * would otherwise show up twice. */
const LEADING_H1 = /^\s*<h1>[\s\S]*?<\/h1>\s*/;

export interface RenderedDoc {
  readonly html: string;
  readonly headings: { readonly id: string; readonly text: string }[];
}

export const renderDoc = (
  markdown: string,
  targets: LinkTargets,
): RenderedDoc => {
  const headings: { id: string; text: string }[] = [];
  const seen = new Map<string, number>();

  let html = Bun.markdown.html(markdown).replace(LEADING_H1, '');

  html = html.replace(HEADING, (_match, level: string, inner: string) => {
    const text = decode(inner);
    const base = slugify(text) || `section-${headings.length}`;
    const count = seen.get(base) ?? 0;
    seen.set(base, count + 1);
    const id = count === 0 ? base : `${base}-${count}`;
    if (level === '2' || level === '3') headings.push({ id, text });
    return `<h${level} id="${id}">${inner}</h${level}>`;
  });

  html = html.replace(
    ANCHOR,
    (_match, href: string) => `<a href="${rewriteHref(href, targets)}"`,
  );

  return { html, headings };
};

export const titleOf = (markdown: string, fallback: string): string => {
  const match = /^#\s+(.+)$/m.exec(markdown);
  return match?.[1]?.replace(/`/g, '').trim() ?? fallback;
};

export const buildGuide = (
  slug: string,
  source: string,
  markdown: string,
  targets: LinkTargets,
  fallbackTitle: string,
): GuidePage => {
  const { html, headings } = renderDoc(markdown, targets);
  return {
    slug,
    source,
    title: titleOf(markdown, fallbackTitle),
    html,
    headings,
  };
};
