/**
 * The documentation site's origin.
 *
 * Three scripts write links into output somebody else reads: the README
 * generator, the GitHub release notes, and the redirect that replaced the
 * GitHub Pages deployment. `internal/docs` and `@dunx/create-app` hold their own
 * copies, being separate projects that cannot import this one, and
 * `scripts/site.test.ts` is what keeps all of them saying the same thing.
 */
export const SITE_URL = 'https://dunx.win';

/** The page that renders one release, as a GitHub release note links it. */
export const releasePageUrl = (version: string): string =>
  `${SITE_URL}/releases/${version}`;
