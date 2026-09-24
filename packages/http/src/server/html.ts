/**
 * Serialise a value for a `<script type="application/json">` block.
 *
 * `<` is the only character that can end the data block early, and escaping it as
 * `\u003c` keeps the text valid JSON - the parser sees the same document either
 * way. `@dunx/dashboard` and `@dunx/openapi` both inline a model into a page they
 * serve, and both had a copy of this; if the escaping ever proves insufficient,
 * one fix should cover both pages.
 */
export const embedJson = (value: unknown): string =>
  JSON.stringify(value).replaceAll('<', '\\u003c');

/**
 * The CSP source for a script file on another origin: its origin, or its bare host
 * for a protocol-relative URL, which takes the page's own scheme. A relative or
 * `data:` source adds nothing: 'self' covers the one and nothing should admit the
 * other.
 */
const sourceOf = (src: string): string | undefined => {
  if (src.startsWith('//')) return URL.parse(`https:${src}`)?.host;
  if (!/^https?:/i.test(src)) return undefined;
  return URL.parse(src)?.origin;
};

const executes = (type: string | null): boolean => {
  const kind = (type ?? '').trim().toLowerCase();
  return kind === '' || kind === 'module' || kind.includes('javascript');
};

/**
 * A `Content-Security-Policy` admitting exactly the inline scripts in `html`, by
 * hash, plus same-origin script files and the origin of each script file it loads
 * from elsewhere, so a renderer that pulls its bundle off a CDN keeps working. Styles, images, fonts and connections are
 * left unrestricted, which is what the API explorers, the dashboard and
 * bull-board need (docs/architecture/constraints.md, "Security response
 * headers"). A page sets it on its own response, and `securityHeaders` keeps it.
 *
 * Only for a page built from trusted parts. A script that user input got into
 * `html` is hashed along with the rest, so it would be admitted too. Computed
 * once per page, not per request: it parses the whole document.
 */
export const inlineScriptPolicy = (html: string): string => {
  const hashes: string[] = [];
  const origins: string[] = [];
  let script: string | undefined;
  new HTMLRewriter()
    .on('script', {
      element(element) {
        const src = element.getAttribute('src');
        if (src !== null) {
          const source = sourceOf(src);
          if (source !== undefined) origins.push(source);
          return;
        }
        if (!executes(element.getAttribute('type'))) return;
        script = '';
        element.onEndTag(() => {
          const digest = new Bun.CryptoHasher('sha256')
            .update(script ?? '')
            .digest('base64');
          hashes.push(`'sha256-${digest}'`);
          script = undefined;
        });
      },
      text(chunk) {
        if (script !== undefined) script += chunk.text;
      },
    })
    .transform(html);
  return [
    `script-src ${["'self'", ...new Set(origins), ...new Set(hashes)].join(' ')}`,
    "object-src 'none'",
    "base-uri 'self'",
  ].join('; ');
};
