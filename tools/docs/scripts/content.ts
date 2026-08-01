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
