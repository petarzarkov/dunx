/**
 * The crawler-visible body for each page `seo.ts` writes.
 *
 * Every one of those files used to carry an empty `<div id="root"></div>`: a
 * correct head over no text at all. Fetching <https://dunx.win/> without
 * JavaScript returned the title and nothing else, and on a domain with no
 * history the first, unrendered pass is what the initial ranking is computed
 * from. The empty body also meant zero `<a href>` in the markup, so the only
 * route to a guide was `sitemap.xml`; the nav that links them is inside the
 * bundle.
 *
 * None of the text is written here. A guide's body is the same `html` the
 * generated model already hands `<Prose>`, a package's is its rendered README,
 * and the landing page is built from `scripts/positioning.ts`, which the hero
 * and the README are both generated from. So a prerendered page cannot claim
 * something the site does not.
 *
 * It is written **inside** `#root`. `createRoot().render()` drops the container's
 * existing children on its first render, so there is no hydration contract to
 * satisfy and no second copy of the layout to keep in step. Until the 972 KB
 * bundle has parsed, a reader sees the same prose the app is about to draw.
 */

import { CAPABILITIES, type Capability } from '../../../scripts/positioning.js';

/**
 * Enough style that the frame before the bundle mounts reads as a document.
 *
 * The site's own stylesheet is a `<link>` in the same head, so the background
 * and the type are already right; what it has no rule for is this markup, which
 * rendered edge to edge at the full window width. Six declarations rather than a
 * second copy of the layout: the app replaces all of it within a few hundred
 * milliseconds, and anything more here would be a stylesheet to keep in step
 * with the real one.
 *
 * `overflow-x` on `pre` is the one that is not cosmetic. A shiki code block is
 * wider than a phone, and without it the page itself scrolled sideways.
 */
export const PRERENDER_STYLE: string =
  '    <style>[data-prerender]{max-width:52rem;margin:0 auto;padding:2rem 1.25rem;line-height:1.6}' +
  '[data-prerender] h1{font-size:2rem;line-height:1.2;margin-bottom:1rem}' +
  '[data-prerender] nav{margin-top:2.5rem}' +
  '[data-prerender] table{border-collapse:collapse}' +
  '[data-prerender] th{text-align:left;padding-right:1rem;vertical-align:top}' +
  '[data-prerender] pre{overflow-x:auto}</style>';

/**
 * Escapes the five characters that change meaning in markup.
 *
 * Shared with `seo.ts`, which needs the same thing for attribute values: a guide
 * title carrying an ampersand would otherwise end the value it sits in. Text
 * nodes need `&`, `<` and `>`; doing all five in one place is cheaper than two
 * escapers that disagree about which context they were for.
 */
export const escapeHtml = (value: string): string =>
  value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

/**
 * `` `Bun.serve` `` in a capability line, as the site renders it.
 *
 * `CAPABILITIES` is markdown because the README renders it as a table. Escaping
 * first and converting after is what keeps a stray backtick from producing a
 * `<code>` around escaped markup.
 */
const inlineCode = (value: string): string =>
  escapeHtml(value).replace(/`([^`]+)`/g, '<code>$1</code>');

export interface GuideLink {
  readonly slug: string;
  readonly title: string;
}

export interface PackageLink {
  readonly name: string;
  readonly dir: string;
  readonly description: string;
  /** Exported symbol names, as `index.json` already records them. */
  readonly exports: readonly string[];
}

export interface Positioning {
  readonly headline: readonly string[];
  readonly blurb: string;
  readonly chips: readonly string[];
}

/**
 * Everything the body of any one page can be built from.
 *
 * `guideHtml` and `packageReadme` are lookups rather than eager maps: a page
 * needs one of each at most, and the generated guide payloads come to 1 MB
 * together.
 */
export interface Content {
  readonly positioning: Positioning;
  readonly guides: readonly GuideLink[];
  readonly packages: readonly PackageLink[];
  /** The rendered guide body, or `''` when the payload is missing. */
  readonly guideHtml: (slug: string) => string;
  /** The rendered README, or `''` when the payload is missing. */
  readonly packageReadme: (dir: string) => string;
}

const list = (items: readonly string[]): string =>
  `<ul>${items.map((item) => `<li>${item}</li>`).join('')}</ul>`;

const link = (href: string, text: string): string =>
  `<a href="${escapeHtml(href)}">${escapeHtml(text)}</a>`;

/**
 * The same two link lists on every page, which is the part the empty body cost
 * most.
 *
 * A crawler arriving on one guide could reach no other page without executing
 * the bundle, so every route depended on `sitemap.xml` alone for discovery and
 * none of them passed any weight to another. This is the nav the app draws,
 * flattened: 26 guides and 10 reference pages, one hop from anywhere.
 */
export const navBody = (content: Content): string =>
  [
    '<nav aria-label="Documentation">',
    '<h2>Guide</h2>',
    list(
      content.guides.map((guide) => link(`/guide/${guide.slug}`, guide.title)),
    ),
    '<h2>Reference</h2>',
    list(content.packages.map((pkg) => link(`/api/${pkg.dir}`, pkg.name))),
    '</nav>',
  ].join('');

const capabilityRows = (rows: readonly Capability[]): string =>
  rows
    .map(
      (row) =>
        `<tr><th scope="row">${escapeHtml(row.need)}</th><td>${inlineCode(row.gives)}</td></tr>`,
    )
    .join('');

/**
 * The landing page: the hero, then the capability table the README carries.
 *
 * The heading is `HEADLINE` joined the way the hero joins it, so the one `<h1>`
 * a crawler reads is the one a reader sees.
 */
export const homeBody = (content: Content): string => {
  const { headline, blurb, chips } = content.positioning;

  return [
    '<header>',
    `<h1>${escapeHtml(headline.join(' '))}</h1>`,
    `<p>${escapeHtml(blurb)}</p>`,
    list(chips.map((chip) => escapeHtml(chip))),
    '</header>',
    '<section>',
    '<h2>What you get</h2>',
    `<table><tbody>${capabilityRows(CAPABILITIES)}</tbody></table>`,
    '</section>',
    navBody(content),
  ].join('');
};

/**
 * A guide: its heading and the whole rendered body.
 *
 * `html` is already HTML and is inserted as-is. It is the largest thing written
 * here, around 25 KB of prose per page, and it is the entire reason for the
 * exercise.
 */
export const guideBody = (
  title: string,
  html: string,
  content: Content,
): string =>
  [
    '<article>',
    `<h1>${escapeHtml(title)}</h1>`,
    html,
    '</article>',
    navBody(content),
  ].join('');

/**
 * A reference page: the package, its README, and the names it exports.
 *
 * The export list is there for the long tail. `HttpFactory` and `SessionGuard`
 * are what someone already using dunx searches for, and the name appeared
 * nowhere in the markup.
 */
export const packageBody = (pkg: PackageLink, content: Content): string =>
  [
    '<article>',
    `<h1><code>${escapeHtml(pkg.name)}</code></h1>`,
    `<p>${escapeHtml(pkg.description)}</p>`,
    content.packageReadme(pkg.dir),
    ...(pkg.exports.length === 0
      ? []
      : [
          '<h2>Exports</h2>',
          list(pkg.exports.map((name) => `<code>${escapeHtml(name)}</code>`)),
        ]),
    '</article>',
    navBody(content),
  ].join('');

/**
 * A page whose content the build has no text for: the benchmark, coverage and
 * release panels, which are drawn from JSON the bundle fetches.
 *
 * The heading and the description are still worth writing. They are what stops
 * the page being indexed as empty, and the nav below them is what makes it a
 * route into the rest of the site.
 */
export const panelBody = (
  title: string,
  description: string,
  content: Content,
): string =>
  [
    '<article>',
    `<h1>${escapeHtml(title)}</h1>`,
    `<p>${escapeHtml(description)}</p>`,
    '</article>',
    navBody(content),
  ].join('');
