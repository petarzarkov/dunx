import type { SerializedError } from './types.js';

/**
 * Local replacement for `@arkv/shared`'s helper — four lines, so it is not worth
 * a dependency. `Error` is excluded deliberately: the sanitizer serializes those
 * through `serializeError` rather than walking their enumerable properties, of
 * which they have none.
 */
export const isPlainObject = (
  value: unknown,
): value is Record<string, unknown> =>
  typeof value === 'object' &&
  value !== null &&
  !Array.isArray(value) &&
  !(value instanceof Error);

/**
 * `JSON.stringify`, falling back to a replacer that survives cycles and BigInt —
 * the two inputs that make the plain call throw. Local, for the same reason as
 * `isPlainObject`.
 */
export const safeStringify = (value: unknown): string => {
  try {
    return JSON.stringify(value) ?? 'undefined';
  } catch {
    const seen = new WeakSet<object>();
    return (
      JSON.stringify(value, (_key, entry: unknown) => {
        if (entry !== null && typeof entry === 'object') {
          if (seen.has(entry)) return '[Circular]';
          seen.add(entry);
        }
        if (typeof entry === 'bigint') return entry.toString();
        return entry;
      }) ?? 'undefined'
    );
  }
};

/**
 * Stacks are collapsed onto one line so an entry stays one line — a log shipper
 * splitting on newlines would otherwise turn one error into a dozen records.
 */
export const serializeError = (error: Error): SerializedError => ({
  name: error.name,
  message: error.message,
  ...(error.stack === undefined
    ? {}
    : { stack: error.stack.replace(/\n(\s+)?/g, ',') }),
});

/**
 * `Object.entries`, except a getter that throws yields a marker instead of
 * taking the whole log call down with it. Reading a property is the one step of
 * sanitization that runs arbitrary user code.
 */
export const safeEntries = (
  obj: Record<string, unknown>,
): [string, unknown][] =>
  Object.keys(obj).map((key): [string, unknown] => {
    try {
      return [key, obj[key]];
    } catch {
      return [key, '[Getter: threw]'];
    }
  });
