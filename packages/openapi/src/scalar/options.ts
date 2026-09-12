import { embedJson } from '@dunx/http/internal';
import { SHELL_KEYS } from '../shell.js';

/** Scalar's built-in themes. */
export const SCALAR_THEMES = Object.freeze([
  'default',
  'alternate',
  'moon',
  'purple',
  'solarized',
  'bluePlanet',
  'deepSpace',
  'saturn',
  'kepler',
  'mars',
  'laserwave',
  'none',
] as const);

export type ScalarTheme = (typeof SCALAR_THEMES)[number];

export type ScalarLayout = 'modern' | 'classic';

/**
 * Scalar's own configuration, minus the keys dunx owns: `content`, `url` and
 * `spec` describe where the document comes from, and this page embeds it.
 *
 * Function-valued keys are absent too. A server-rendered page cannot carry a
 * closure, and Scalar's are `plugins` and `onRequestSent` rather than the
 * rendering knobs, so there is no `RawJs` seam here as there is for Swagger UI.
 */
export interface ScalarOptions {
  /**
   * The tab icon. A URL, or `false` for none.
   *
   * Defaults to `data:,`, which paints nothing and stops the browser asking for
   * `/favicon.ico` against the app serving the page. Scalar ships no icon of its
   * own, so there is no file to point at.
   */
  readonly favicon?: string | false;

  /** The page `<title>`. Defaults to `"<info.title> <info.version>"`. */
  readonly title?: string;

  readonly theme?: ScalarTheme;
  readonly layout?: ScalarLayout;
  readonly darkMode?: boolean;
  readonly forceDarkModeState?: 'dark' | 'light';
  readonly hideDarkModeToggle?: boolean;
  readonly showSidebar?: boolean;
  readonly hideModels?: boolean;
  readonly hideSearch?: boolean;
  readonly hideDownloadButton?: boolean;
  readonly hideTestRequestButton?: boolean;
  readonly hideClientButton?: boolean;
  readonly defaultOpenAllTags?: boolean;
  readonly documentDownloadType?: 'json' | 'yaml' | 'both' | 'none';
  readonly searchHotKey?: string;
  readonly baseServerURL?: string;
  readonly servers?: readonly unknown[];
  readonly customCss?: string;
  readonly persistAuth?: boolean;
  readonly operationTitleSource?: 'summary' | 'path';
  readonly defaultHttpClient?: {
    readonly targetKey: string;
    readonly clientKey: string;
  };
  /**
   * Scalar's request proxy, which forwards a try-it-out request through
   * `proxy.scalar.com`. Absent, so a request goes straight from the browser to
   * the API and nothing leaves the two hosts involved.
   */
  readonly proxyUrl?: string;
  /**
   * Scalar's own web fonts, fetched from `fonts.scalar.com`.
   *
   * dunx defaults this to `false`: a documentation page that reaches another host
   * for a font is the thing the self-hosted assets exist to avoid. Set it to
   * `true` to take the fonts.
   */
  readonly withDefaultFonts?: boolean;
}

/** dunx's defaults, applied under whatever the caller passed. */
export const DEFAULT_SCALAR_OPTIONS: ScalarOptions = Object.freeze({
  withDefaultFonts: false,
});

/**
 * The `Scalar.createApiReference(el, { ... })` argument, as JSON.
 *
 * `embedJson` rather than `JSON.stringify`: `customCss` is a string that lands
 * inside a `<script>`, so a `</script>` in it would end the block.
 */
export const renderScalarOptions = (options: ScalarOptions): string => {
  const merged: Record<string, unknown> = {
    ...DEFAULT_SCALAR_OPTIONS,
    ...options,
  };

  for (const key of SHELL_KEYS) delete merged[key];
  return embedJson(merged);
};
