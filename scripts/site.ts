/**
 * The documentation site's origin.
 *
 * Two scripts write links into output somebody else reads: the README generator
 * and the GitHub release notes. `internal/docs` and `@dunx/create-app` hold their
 * own copies, being separate projects that cannot import this one.
 */
export const SITE_URL = 'https://dunx.win';

/** The page that renders one release, as a GitHub release note links it. */
export const releasePageUrl = (version: string): string =>
  `${SITE_URL}/releases/${version}`;
