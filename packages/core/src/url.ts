/** Why {@link assertUrl} refused a url. */
export type UrlProblem =
  | { readonly kind: 'invalid' }
  | {
      readonly kind: 'protocol';
      readonly protocol: string;
      /** The url with its password replaced, safe to put in a message. */
      readonly redacted: string;
    };

/** The url with any password replaced by `***`, for logs and error messages. */
export const redactUrl = (url: string): string => {
  const parsed = new URL(url);
  if (parsed.password) parsed.password = '***';
  return parsed.toString();
};

/**
 * Returns `url` when it parses and its scheme is one of `protocols`, and throws
 * what `fail` builds otherwise.
 *
 * `fail` never receives the url as given. A connection url usually holds
 * credentials, a boot error is written by whatever logger is bound, and an
 * unparseable url cannot be redacted, so the only form of it on offer is
 * `redacted`, and only once it has parsed.
 */
export const assertUrl = (
  url: string,
  protocols: readonly string[],
  fail: (problem: UrlProblem) => Error,
): string => {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw fail({ kind: 'invalid' });
  }
  if (!protocols.includes(parsed.protocol)) {
    throw fail({
      kind: 'protocol',
      protocol: parsed.protocol,
      redacted: redactUrl(url),
    });
  }
  return url;
};
