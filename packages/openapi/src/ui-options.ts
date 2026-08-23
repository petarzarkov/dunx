/**
 * Every Swagger UI configuration parameter, as a typed object - the full set from
 * its own reference, minus the four dunx owns: `dom_id`, `domNode`, `spec` and
 * `url`, which describe where the page is mounted rather than how it behaves.
 *
 * Seven of them are functions, and a server-rendered page cannot carry one.
 * `.toString()` would work for a self-contained function and break silently for
 * one that captured anything, so those are {@link RawJs}: the source of an
 * expression, evaluated in the browser. `operationsSorter` and `tagsSorter` also
 * take Swagger UI's `'alpha'`/`'method'` shorthands.
 */

/**
 * The source of a JavaScript expression, evaluated in the browser.
 *
 * Written into the page's boot script verbatim, so it cannot close over anything in
 * the server process and it is not escaped. Only put source you wrote here.
 */
export type RawJs = string;

/** Swagger UI's own highlight.js themes. */
export const SYNTAX_THEMES = Object.freeze([
  'agate',
  'arta',
  'monokai',
  'nord',
  'obsidian',
  'tomorrow-night',
  'idea',
] as const);

export type SyntaxTheme = (typeof SYNTAX_THEMES)[number];

export type DocExpansion = 'list' | 'full' | 'none';
export type ModelRendering = 'example' | 'model';
export type SubmitMethod =
  | 'get'
  | 'put'
  | 'post'
  | 'delete'
  | 'options'
  | 'head'
  | 'patch'
  | 'trace';

export interface SyntaxHighlightOptions {
  readonly activated?: boolean;
  readonly theme?: SyntaxTheme;
}

export interface SwaggerUiOptions {
  /**
   * The tab icon. A URL, or `false` for none.
   *
   * Defaults to Swagger UI's own `favicon-32x32.png`, served from the same install
   * as the rest of the page. Any other value is used verbatim, so a `data:` URI
   * costs no request and an absolute URL is the one way this page reaches another
   * host - which `html.test.ts` allows only because you asked for it.
   */
  readonly favicon?: string | false;

  /** The page `<title>`. Defaults to `"<info.title> <info.version>"`. */
  readonly title?: string;

  readonly layout?: string;
  readonly queryConfigEnabled?: boolean;
  readonly configUrl?: string;
  /** Extra definitions for the topbar plugin. Needs a `layout` that renders one. */
  readonly urls?: readonly { readonly url: string; readonly name: string }[];
  readonly 'urls.primaryName'?: string;

  readonly deepLinking?: boolean;
  readonly displayOperationId?: boolean;
  readonly defaultModelsExpandDepth?: number;
  readonly defaultModelExpandDepth?: number;
  readonly defaultModelRendering?: ModelRendering;
  readonly displayRequestDuration?: boolean;
  readonly docExpansion?: DocExpansion;
  readonly filter?: boolean | string;
  readonly maxDisplayedTags?: number;
  readonly showExtensions?: boolean;
  readonly showCommonExtensions?: boolean;
  readonly tryItOutEnabled?: boolean;
  readonly requestSnippetsEnabled?: boolean;
  readonly requestSnippets?: Readonly<Record<string, unknown>>;
  readonly syntaxHighlight?: boolean | SyntaxHighlightOptions;
  /** Deprecated upstream: leaves `style`, `class` and `data-*` in markdown. */
  readonly useUnsafeMarkdown?: boolean;

  readonly oauth2RedirectUrl?: string;
  readonly showMutatedRequest?: boolean;
  readonly supportedSubmitMethods?: readonly SubmitMethod[];
  /**
   * Swagger UI defaults this to `https://validator.swagger.io/validator`, which
   * sends your document to a third party. **dunx defaults it to `null`**, which
   * disables the badge, because a documentation page that silently uploads the API
   * surface of the service serving it is not a reasonable default. Set it back
   * explicitly if you want it.
   */
  readonly validatorUrl?: string | null;
  readonly withCredentials?: boolean;
  readonly persistAuthorization?: boolean;
  readonly request?: { readonly curlOptions?: readonly string[] };

  /** `'alpha'`, `'method'`, or the source of a comparator. */
  readonly operationsSorter?: 'alpha' | 'method' | RawJs;
  /** `'alpha'`, or the source of a comparator. */
  readonly tagsSorter?: 'alpha' | RawJs;
  /** Source of `(request) => request`. */
  readonly requestInterceptor?: RawJs;
  /** Source of `(response) => response`. */
  readonly responseInterceptor?: RawJs;
  /** Source of `(property) => unknown`. */
  readonly modelPropertyMacro?: RawJs;
  /** Source of `(parameter) => unknown`. */
  readonly parameterMacro?: RawJs;
  /** Source of `() => void`, run once the UI has rendered. */
  readonly onComplete?: RawJs;
  /** Source of an array expression, e.g. `[SwaggerUIBundle.plugins.DownloadUrl]`. */
  readonly plugins?: RawJs;
  /** Source of an array expression. Defaults to `[SwaggerUIBundle.presets.apis]`. */
  readonly presets?: RawJs;
}

/**
 * The keys whose value is emitted as **source** rather than JSON.
 *
 * `operationsSorter` and `tagsSorter` are in both worlds: Swagger UI accepts the
 * strings `'alpha'` and `'method'` as shorthands, so those are quoted as data and
 * anything else is treated as an expression. That is the one place this module
 * guesses, and it guesses on an exact match against a two-item list.
 */
const RAW_KEYS = Object.freeze([
  'requestInterceptor',
  'responseInterceptor',
  'modelPropertyMacro',
  'parameterMacro',
  'onComplete',
  'plugins',
  'presets',
] as const);

const SORTER_SHORTHANDS = Object.freeze(['alpha', 'method'] as const);

/** Keys dunx consumes itself rather than forwarding to Swagger UI. */
const DUNX_KEYS = Object.freeze(['favicon', 'title'] as const);

const isRawKey = (key: string): boolean =>
  (RAW_KEYS as readonly string[]).includes(key);

const isSorter = (key: string): boolean =>
  key === 'operationsSorter' || key === 'tagsSorter';

/**
 * dunx's defaults, applied under whatever the caller passed.
 *
 * `deepLinking` because a link to an operation is the main thing anyone wants from
 * a docs page, and `validatorUrl: null` because the upstream default uploads the
 * document to swagger.io.
 */
export const DEFAULT_UI_OPTIONS: SwaggerUiOptions = Object.freeze({
  deepLinking: true,
  validatorUrl: null,
});

/**
 * The `SwaggerUIBundle({ ... })` argument, as source.
 *
 * Assembled by hand rather than with `JSON.stringify` over the whole object,
 * because the raw-source keys have to land unquoted next to the JSON ones.
 */
export const renderUiOptions = (
  options: SwaggerUiOptions,
  domId: string,
): string => {
  const merged: Record<string, unknown> = {
    ...DEFAULT_UI_OPTIONS,
    ...options,
  };
  const parts = [`dom_id:${JSON.stringify(`#${domId}`)}`];

  for (const [key, value] of Object.entries(merged)) {
    if (value === undefined) continue;
    if ((DUNX_KEYS as readonly string[]).includes(key)) continue;

    if (isRawKey(key) || (isSorter(key) && !isShorthand(value))) {
      parts.push(`${JSON.stringify(key)}:${String(value)}`);
      continue;
    }
    parts.push(`${JSON.stringify(key)}:${JSON.stringify(value)}`);
  }

  // `presets` is the one default that has to be source: it names a property of the
  // bundle's own global, which does not exist until the script has run.
  if (merged['presets'] === undefined) {
    parts.push('presets:[SwaggerUIBundle.presets.apis]');
  }

  return `{${parts.join(',')}}`;
};

const isShorthand = (value: unknown): boolean =>
  typeof value === 'string' &&
  (SORTER_SHORTHANDS as readonly string[]).includes(value);
