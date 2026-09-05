/**
 * The site that replaces the GitHub Pages deployment once dunx.win is live.
 *
 * Pages has no server-side redirect, so the forwarding is a script in the
 * document. `404.html` carries the same one, which is how a path that was never
 * a file - anything but the two documents below - reaches the new host.
 *
 * Two files are served rather than redirected. Every `@dunx/create-app` already
 * on npm writes `https://petarzarkov.github.io/dunx/setup.md` into the AGENTS.md
 * of the app it scaffolds, and an agent fetching raw markdown runs no script, so
 * a redirect page would hand it a redirect page. They are copied from the built
 * site, so they say what the current release says and point onward at dunx.win.
 */

import { copyFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { SITE_URL } from './site.js';

/** The repository path the old site was served under. */
const OLD_BASE = '/dunx';

/**
 * `location.replace` rather than a meta refresh, so the old URL leaves no entry
 * in the back button, and it runs while the document parses rather than after
 * it. The `noscript` refresh is the fallback, where a race with the script is
 * impossible by definition.
 *
 * A hash route is already the new path: `/dunx/#/guide/controllers?h=nesting`
 * forwards to `https://dunx.win/guide/controllers?h=nesting` by concatenation,
 * which is the whole reason the history router kept the same route shapes.
 */
export const redirectHtml = (): string => `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="robots" content="noindex" />
    <link rel="canonical" href="${SITE_URL}/" />
    <title>dunx has moved to dunx.win</title>
    <script>
      (function () {
        var base = '${SITE_URL}';
        var hash = window.location.hash.replace(/^#/, '');
        if (hash !== '') {
          window.location.replace(base + hash);
          return;
        }
        var path = window.location.pathname.replace(/^\\${OLD_BASE}/, '');
        if (path === '/') path = '';
        window.location.replace(base + path + window.location.search);
      })();
    </script>
    <noscript>
      <meta http-equiv="refresh" content="0; url=${SITE_URL}/" />
    </noscript>
    <style>
      body {
        font-family: ui-sans-serif, system-ui, sans-serif;
        margin: 4rem auto;
        max-width: 32rem;
        padding: 0 1rem;
      }
    </style>
  </head>
  <body>
    <h1>dunx has moved</h1>
    <p>
      The documentation is now at <a href="${SITE_URL}/">dunx.win</a>.
    </p>
  </body>
</html>
`;

/** The documents an agent fetches raw, which a redirect cannot serve. */
const CARRIED = ['setup.md', 'llms.txt'] as const;

export const buildRedirectSite = (outDir: string, publicDir: string): void => {
  mkdirSync(outDir, { recursive: true });

  const html = redirectHtml();
  writeFileSync(join(outDir, 'index.html'), html);
  writeFileSync(join(outDir, '404.html'), html);

  const missing = CARRIED.filter((file) => !existsSync(join(publicDir, file)));
  if (missing.length > 0) {
    throw new Error(
      `${missing.join(' and ')} missing from ${publicDir}. Run \`bun run --filter '@dunx/docs' generate\` first.`,
    );
  }
  for (const file of CARRIED) {
    copyFileSync(join(publicDir, file), join(outDir, file));
  }
};

if (import.meta.main) {
  const root = new URL('..', import.meta.url).pathname;
  const outDir = join(root, '.pages-redirect');
  buildRedirectSite(outDir, join(root, 'internal/docs/public'));
  console.log(`Redirect site written to ${outDir}`);
}
