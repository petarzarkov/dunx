import { MantineProvider } from '@mantine/core';
import { theme } from '@dunx/ui';
import { renderToString } from 'react-dom/server';
import { jsonLdFor, type Entity } from '../scripts/json-ld';
import {
  clamp,
  escapeHtml as attr,
  pagesOf,
  SITE_ORIGIN,
  type PageMeta,
  type ReleaseEntry,
} from '../scripts/pages';
import { App } from './App';
import { loadGuide, loadPackage, loadReleases, site } from './data';
import { parseRoute, RouteKind } from './router';

/**
 * The site's own React tree, rendered to HTML per route by the `dunx:pages`
 * plugin in `vite.config.ts`.
 *
 * Every page used to carry a hand-written body instead - a heading, the guide's
 * prose and two flat link lists, styled by six declarations that had nothing to
 * do with the real stylesheet. It read as a bare document until the bundle
 * mounted and replaced it: no header, no sidebar, no contents rail, and the
 * heading 20px from where the app was about to put it. Measured on a throttled
 * connection, that frame was on screen for the 4.5 s between the two paints.
 *
 * Rendering the actual tree removes the swap rather than dressing it up, and
 * removes the second layout with it. There is nothing here to keep in step with
 * `App.tsx`, because it **is** `App.tsx`.
 *
 * No `StrictMode` and no CSS imports: `renderToString` ignores the first, and
 * the shell the plugin injects into already links the stylesheet.
 */
export const renderPage = async (
  path: string,
): Promise<{ html: string; title: string; head: string }> => {
  const route = parseRoute(path);

  // Awaited before the render, because `useChunk` fills its body from an effect
  // and effects do not run here. Its `peek` reads the same cache these populate,
  // so the render draws the prose rather than the skeleton.
  if (route.kind === RouteKind.Guide) await loadGuide(route.slug);
  if (route.kind === RouteKind.Api) await loadPackage(route.slug);

  const releases = (await loadReleases()) ?? [];

  // `/404` is the shell with no body: a not-found page carrying the site's whole
  // nav is a soft-404 signal, and `_redirects` was rewritten to stop producing
  // those. Cloudflare serves this file with a real status and the router draws
  // its own panel once the bundle boots.
  const html =
    path === '/404'
      ? ''
      : renderToString(
          <MantineProvider theme={theme} defaultColorScheme="auto">
            <App url={path} />
          </MantineProvider>,
        );

  return { html, ...headFor(path, releases) };
};

/**
 * The social card, at the 1.91:1 the unfurlers crop to.
 *
 * There used to be no `og:image` at all, because every image the site had was an
 * SVG and the major unfurlers decline to render one. `scripts/og-card.ts` draws
 * a PNG through the `Bun.WebView` the screenshot suite already uses, so the tag
 * points at a raster file and `summary_large_image` is honest.
 */
const OG_IMAGE = `${SITE_ORIGIN}/og.png`;

const NOT_FOUND: PageMeta = {
  path: '/404',
  title: 'Not found | dunx',
  description: 'That page does not exist on the dunx documentation site.',
  kind: 'website',
};

const headFor = (
  path: string,
  releases: readonly ReleaseEntry[],
): { title: string; head: string } => {
  const page =
    pagesOf(site, releases).find((candidate) => candidate.path === path) ??
    NOT_FOUND;
  const url = `${SITE_ORIGIN}${page.path}`;
  const description = clamp(page.description);
  const entity: Entity = {
    origin: SITE_ORIGIN,
    repoUrl: site.repoUrl ?? 'https://github.com/petarzarkov/dunx',
    version: releases[0]?.version ?? null,
  };

  const meta = (key: string, value: string, content: string): string =>
    `    <meta ${key}="${value}" content="${attr(content)}" />`;

  return {
    title: page.title,
    head: [
      `    <link rel="canonical" href="${attr(url)}" />`,
      meta('name', 'description', description),
      meta('property', 'og:type', page.kind),
      meta('property', 'og:site_name', 'dunx'),
      meta('property', 'og:title', page.title),
      meta('property', 'og:description', description),
      meta('property', 'og:url', url),
      meta('property', 'og:image', OG_IMAGE),
      meta('property', 'og:image:width', '1200'),
      meta('property', 'og:image:height', '630'),
      meta('name', 'twitter:card', 'summary_large_image'),
      meta('name', 'twitter:title', page.title),
      meta('name', 'twitter:description', description),
      meta('name', 'twitter:image', OG_IMAGE),
      ...jsonLdFor({
        entity,
        path: page.path,
        title: page.title,
        description,
        kind: page.kind,
      }).map(
        (json) => `    <script type="application/ld+json">${json}</script>`,
      ),
    ].join('\n'),
  };
};
