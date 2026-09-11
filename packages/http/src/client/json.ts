/**
 * A `JSON.stringify` that survives a cycle. **For logging only.**
 *
 * Never for a request body. The implementation this was ported from used it for
 * both, so a circular payload was *sent* upstream as `"[Circular]"` - a wrong body
 * that reads as a successful call and comes back as someone else's 400. A body goes
 * through plain `JSON.stringify`, which throws, because a cycle there is a bug in
 * the caller and should say so.
 */
export const safeStringify = (value: unknown): string => {
  const seen = new WeakSet<object>();
  return JSON.stringify(value, (_key, entry: unknown) => {
    if (typeof entry === 'object' && entry !== null) {
      if (seen.has(entry)) return '[Circular]';
      seen.add(entry);
    }
    return entry;
  });
};

// Declared by `@dunx/core`, which needs the same predicate to merge config
// files: `Bun.TOML.parse` returns `Temporal` values that the loose check
// mistakes for mergeable objects. Re-exported so this module's consumers and
// its tests keep their import path.
export { isPlainObject } from '@dunx/core';
/**
 * Whether a payload should be JSON-encoded, or handed to `fetch` as-is.
 *
 * `fetch` already knows what to do with a `BodyInit` - it sets the boundary for a
 * `FormData`, the content type for a `URLSearchParams`, streams a `ReadableStream`
 * - so the only question is whether this value is one. Everything else, including
 * a `Date` or a class instance, is JSON: that is what `JSON.stringify` is for.
 *
 * Listed explicitly rather than inferred from `isPlainObject`, because the two
 * questions have different answers. `new Date()` is not a plain object but is
 * JSON-encodable; a `Blob` is neither.
 */
export const isJsonBody = (payload: unknown): boolean => {
  if (payload === null || payload === undefined) return false;
  if (typeof payload !== 'object') return typeof payload !== 'string';
  return !(
    payload instanceof FormData ||
    payload instanceof URLSearchParams ||
    payload instanceof Blob ||
    payload instanceof ArrayBuffer ||
    payload instanceof ReadableStream ||
    ArrayBuffer.isView(payload)
  );
};

/**
 * JSON when the upstream said so or the body parses; text otherwise; undefined
 * for empty.
 *
 * **A failed read rejects.** It used to be caught and reported as an empty body,
 * so a 2xx whose body died mid-stream reached the caller as a success with no
 * data, and a retry policy saw nothing to retry. A caller that wants the old
 * behaviour asks for it: the two error paths in `HttpService` do, because there
 * the status is the signal and an unreadable body should not replace it.
 */
export const readBody = async (response: Response): Promise<unknown> => {
  const text = await response.text();
  if (text === '') return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
};
