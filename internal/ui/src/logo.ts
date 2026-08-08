/**
 * The mark, once.
 *
 * It was drawn three times - as JSX in `Logo.tsx`, as `public/logo/*.svg` for the
 * documentation site, and nowhere at all for the two pages a backend serves, which
 * is why the API explorer and the dashboard shipped with a blank tab icon. The
 * geometry is here now and everything else derives from it.
 *
 * The mark is the wordmark's own last two letters: the `n` - an arch on two legs -
 * sheltering the `x`.
 */
export const ARCH = 'M5.6 26.1V16.3a10.4 10.4 0 0 1 20.8 0v9.8';
export const CROSS = 'm11.4 13.1 9.2 9.2m0-9.2-9.2 9.2';

export const ACCENT = Object.freeze({
  from: '#22b8cf',
  via: '#4c6ef5',
  to: '#7950f2',
} as const);

/**
 * The standalone, full-colour cut - both strokes on the gradient rather than the
 * arch on `currentColor`.
 *
 * A tab strip's background is not something the page controls, so `currentColor`
 * would resolve against whatever the browser chrome happens to be. This is the
 * version for a favicon, a README and anywhere else the mark leaves the page.
 *
 * Kept as a single line: it becomes a `data:` URI, and a newline in one is legal
 * but pointless bytes.
 */
export const LOGO_MARK_SVG: string =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" width="32" ' +
  'height="32" fill="none" role="img" aria-label="dunx">' +
  '<linearGradient id="dunx-c" x1="4" y1="4" x2="28" y2="28" ' +
  'gradientUnits="userSpaceOnUse">' +
  `<stop offset="0" stop-color="${ACCENT.from}"/>` +
  `<stop offset=".5" stop-color="${ACCENT.via}"/>` +
  `<stop offset="1" stop-color="${ACCENT.to}"/>` +
  '</linearGradient>' +
  '<g stroke="url(#dunx-c)" stroke-width="4" stroke-linecap="round">' +
  `<path d="${ARCH}"/><path d="${CROSS}"/>` +
  '</g></svg>';

/**
 * The same, as a `data:` URI for a `<link rel="icon">`.
 *
 * Encoded rather than base64'd - an SVG is text, and percent-encoding only the
 * handful of characters a URI cannot carry keeps it readable and slightly smaller.
 * A page that inlines this fetches nothing for its own icon, which is the whole
 * point for a page a backend serves with no egress.
 */
export const LOGO_FAVICON = `data:image/svg+xml,${LOGO_MARK_SVG.replace(
  /[#<>"{}|\\^`\s]/g,
  (char) => encodeURIComponent(char),
)}`;
