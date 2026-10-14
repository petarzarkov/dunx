/**
 * The pathname of an absolute URL, without parsing scheme, host, port or query.
 *
 * `new URL(req.url).pathname` resolves all of those to reach one string and
 * measured ~1,000 ns, where two `indexOf` calls and a `slice` are ~100 ns.
 * `RequestLoggingMiddleware` already takes this slice inline for the same reason.
 */
export const pathnameOf = (url: string): string => {
  const from = url.indexOf('/', url.indexOf('://') + 3);
  if (from === -1) return '/';
  const mark = url.indexOf('?', from);
  return mark === -1 ? url.slice(from) : url.slice(from, mark);
};
