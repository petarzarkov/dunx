import { createHighlighter, type Highlighter } from 'shiki';

/**
 * Syntax highlighting, done here rather than in the browser.
 *
 * shiki carries a TextMate grammar per language and a full theme; shipping it to
 * the client would cost more than the entire current bundle. Every code block on
 * this site is known at generate time, so it is highlighted once into static HTML
 * and the browser downloads no highlighter at all.
 *
 * Both themes are emitted in one pass. shiki writes the light colour as an inline
 * `color:` and the dark one as a `--shiki-dark` custom property, so the scheme
 * switch is a CSS rule rather than a re-render. See `.shiki` in `styles.css`.
 */
const LANGS = [
  'typescript',
  'tsx',
  'javascript',
  'json',
  'bash',
  'shell',
  'toml',
  'yaml',
  'dockerfile',
  'sql',
  'html',
  'css',
  'markdown',
  'diff',
];

/** What a fence might say, mapped to what shiki calls it. */
const ALIASES: Record<string, string> = {
  ts: 'typescript',
  js: 'javascript',
  jsx: 'tsx',
  sh: 'bash',
  yml: 'yaml',
  md: 'markdown',
  console: 'bash',
  text: 'plaintext',
  txt: 'plaintext',
};

let highlighter: Highlighter | undefined;

export const startHighlighter = async (): Promise<void> => {
  highlighter ??= await createHighlighter({
    themes: ['github-light', 'github-dark'],
    langs: LANGS,
  });
};

/** Bun's markdown output is HTML, so the code inside a fence arrives escaped. */
const unescape = (html: string): string =>
  html
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#(?:39|x27);/g, "'")
    .replace(/&amp;/g, '&');

const resolveLang = (raw: string): string => {
  const lang = ALIASES[raw] ?? raw;
  return highlighter?.getLoadedLanguages().includes(lang) ? lang : 'plaintext';
};

/**
 * shiki stamps `style="--shiki-light:#RRGGBB;--shiki-dark:#RRGGBB"` on every
 * token. Across 21 guides that was +172 KB gzipped, which is far too much to pay
 * for syntax colour, so each distinct pair is interned as a class instead and the
 * stylesheet is emitted once.
 */
const palette = new Map<string, string>();

const intern = (declaration: string): string => {
  const existing = palette.get(declaration);
  if (existing !== undefined) return existing;
  const name = `s${palette.size.toString(36)}`;
  palette.set(declaration, name);
  return name;
};

const TOKEN_STYLE = /style="(--shiki-light:[^"]*)"/g;

/** The stylesheet for every class interned so far. Written after generation. */
export const paletteCss = (): string =>
  [...palette]
    .map(([declaration, name]) => `.shiki .${name}{${declaration}}`)
    .join('\n');

export const highlight = (code: string, lang: string): string => {
  if (!highlighter) {
    throw new Error('startHighlighter() must be awaited before highlight()');
  }
  const html = highlighter.codeToHtml(code, {
    lang: resolveLang(lang),
    themes: { light: 'github-light', dark: 'github-dark' },
    defaultColor: false,
  });
  // The <pre>'s own style carries the background and is left alone; only the
  // per-token spans are interned.
  return html.replace(
    TOKEN_STYLE,
    (match, declaration: string, offset: number) =>
      offset < html.indexOf('<code') ? match : `class="${intern(declaration)}"`,
  );
};

const FENCE =
  /<pre><code(?: class="language-([^"]+)")?>([\s\S]*?)<\/code><\/pre>/g;

/** What the badge shows. Anything not here is upper-cased as-is. */
const LABELS: Readonly<Record<string, string>> = {
  ts: 'TS',
  typescript: 'TS',
  js: 'JS',
  javascript: 'JS',
  jsonc: 'JSON',
  bash: 'SH',
  sh: 'SH',
  shell: 'SH',
  dockerfile: 'DOCKER',
  plaintext: '',
};

const escapeAttr = (text: string): string =>
  text.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');

/**
 * Replaces every fenced block Bun's markdown renderer produced, wrapping it in a
 * frame with the language, an optional filename and a copy button.
 *
 * **The filename rides in the language token**, as ```` ```ts:users.controller.ts ````.
 * Bun's markdown renderer drops everything after the language word, so the
 * conventional ` title="..." ` never reaches the HTML - measured, not assumed.
 * A colon survives because it lands inside `class="language-..."`.
 *
 * A block with no language still gets the frame, so it does not read as a
 * different component from the rest.
 */
export const highlightFences = (html: string): string =>
  html.replace(FENCE, (_match, info: string | undefined, body: string) => {
    const [lang = 'plaintext', ...rest] = (info ?? 'plaintext').split(':');
    const file = rest.join(':');
    const label = LABELS[lang] ?? lang.toUpperCase();
    const code = unescape(body).replace(/\n$/, '');

    const left = file
      ? `<span class="code-file">${escapeAttr(file)}</span>`
      : '<span></span>';
    const badge = label ? `<span class="code-lang">${label}</span>` : '';

    return (
      `<figure class="code-block">` +
      `<figcaption class="code-bar">${left}<span class="code-actions">${badge}` +
      // No `onclick`: the handler is delegated from `Prose`, so the markup stays
      // inert HTML the generator can emit and the CSP has nothing to allow.
      `<button type="button" class="code-copy" aria-label="Copy code">Copy</button>` +
      `</span></figcaption>` +
      `${highlight(code, lang)}</figure>`
    );
  });
