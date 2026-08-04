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

/**
 * A plain object: `{}`, `Object.create(null)`, or a JSON-parsed value. Anything
 * with its own prototype - `Date`, `Map`, `Error`, a class instance - is not one.
 *
 * The prototype check rather than the reference's `typeof === 'object' && !Array
 * && !(instanceof Error)`, which answered `true` for a `Date` and for every class
 * instance, so "is this a plain object" did not mean what it said. Body routing
 * does not use this - see {@link isJsonBody} - so tightening it changes no
 * behaviour beyond making the predicate honest.
 */
export const isPlainObject = (
  value: unknown,
): value is Record<string, unknown> => {
  if (typeof value !== 'object' || value === null) return false;
  const proto = Object.getPrototypeOf(value) as object | null;
  return proto === Object.prototype || proto === null;
};

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
