import { safeEntries, serializeError } from './serialize.js';
import type { LogEntry } from './types.js';

export interface SanitizeOptions {
  readonly maskFields: readonly string[];
  readonly maxArrayLength: number;
  readonly maxDepth: number;
}

const MASKED = '[MASKED]';

/**
 * Substring, case-insensitive: `xApiKey`, `api_key_header` and `Authorization`
 * all match, which is the point — a masking list that only caught exact names
 * would miss every real-world variant.
 */
const isMasked = (key: string, fields: readonly string[]): boolean => {
  const lower = key.toLowerCase();
  return fields.some((field) => lower.includes(field.toLowerCase()));
};

interface FileLike {
  readonly name: string;
  readonly size: number;
  readonly type: string;
}

/**
 * Duck-typed rather than `instanceof File`, so `Bun.file()`'s `BunFile` is
 * described the same way. Checked before `Blob`, which `File` extends.
 *
 * The property *types* are checked, not just their presence: a plain `Blob` in Bun
 * answers `'name' in blob` with `true` — the key exists with the value `undefined`
 * — so a presence check alone describes every Blob as `[File: undefined ...]`.
 */
const isFileLike = (value: object): value is FileLike =>
  typeof (value as { name?: unknown }).name === 'string' &&
  typeof (value as { size?: unknown }).size === 'number' &&
  typeof (value as { type?: unknown }).type === 'string' &&
  typeof (value as { arrayBuffer?: unknown }).arrayBuffer === 'function';

const describeFile = (file: FileLike): string =>
  `[File: ${file.name} (${file.size} bytes, ${file.type})]`;

const fromFormData = (form: FormData): LogEntry => {
  const entries: LogEntry = {};
  for (const [key, value] of form.entries()) {
    entries[key] = typeof value === 'string' ? value : describeFile(value);
  }
  return { '[FormData]': entries };
};

/**
 * `JSON.stringify(new Map([['a', 1]]))` is `{}` — the entries are invisible to it,
 * so a Map logged as-is loses everything silently. Kept as `[key, value]` pairs
 * because a Map's keys need not be strings, and masked by key so
 * `new Map([['password', x]])` is no more of a leak than `{ password: x }`.
 */
const fromMap = (
  map: ReadonlyMap<unknown, unknown>,
  options: SanitizeOptions,
  seen: WeakSet<object>,
  depth: number,
): LogEntry => {
  const pairs: unknown[] = [];
  for (const [key, value] of map) {
    if (pairs.length >= options.maxArrayLength) {
      pairs.push(
        `[TRUNCATED: ${map.size - options.maxArrayLength} more entries]`,
      );
      break;
    }
    pairs.push([
      sanitizeValue(key, options, seen, depth + 1),
      typeof key === 'string' && isMasked(key, options.maskFields)
        ? MASKED
        : sanitizeValue(value, options, seen, depth + 1),
    ]);
  }
  return { '[Map]': pairs };
};

const sanitizeArray = (
  array: readonly unknown[],
  options: SanitizeOptions,
  seen: WeakSet<object>,
  depth: number,
): unknown[] => {
  const kept = Math.min(array.length, options.maxArrayLength);
  const cleaned: unknown[] = [];
  for (let index = 0; index < kept; index += 1) {
    cleaned.push(sanitizeValue(array[index], options, seen, depth + 1));
  }
  if (array.length > kept) {
    cleaned.push(`[TRUNCATED: ${array.length - kept} more items]`);
  }
  return cleaned;
};

const sanitizeObject = (
  obj: Record<string, unknown>,
  options: SanitizeOptions,
  seen: WeakSet<object>,
  depth: number,
): LogEntry => {
  const cleaned: LogEntry = {};
  // safeEntries, not Object.entries: reading a property runs a getter, and one
  // that throws would otherwise take down the log call that was reporting it.
  for (const [key, value] of safeEntries(obj)) {
    if (value === undefined || value === null) continue;
    cleaned[key] = isMasked(key, options.maskFields)
      ? MASKED
      : sanitizeValue(value, options, seen, depth + 1);
  }
  return cleaned;
};

const sanitizeValue = (
  value: unknown,
  options: SanitizeOptions,
  seen: WeakSet<object>,
  depth: number,
): unknown => {
  if (value === null || value === undefined) return value;

  switch (typeof value) {
    case 'function':
      return `[Function: ${(value as { name?: string }).name || 'anonymous'}]`;
    case 'symbol':
      return `[Symbol: ${value.toString()}]`;
    case 'bigint':
      return `[BigInt: ${value.toString()}]`;
    case 'object':
      break;
    default:
      return value;
  }

  if (value instanceof Date) {
    // `new Date('nope').toISOString()` throws RangeError. A log call must not.
    return Number.isNaN(value.getTime())
      ? '[Date: Invalid Date]'
      : value.toISOString();
  }
  if (value instanceof RegExp) return `[RegExp: ${value.toString()}]`;
  if (value instanceof Error) return serializeError(value);
  if (value instanceof FormData) return fromFormData(value);
  if (isFileLike(value)) return describeFile(value);
  if (value instanceof Blob) {
    return `[Blob: ${value.size} bytes, ${value.type}]`;
  }
  if (value instanceof ArrayBuffer) {
    return `[ArrayBuffer: ${value.byteLength} bytes]`;
  }
  // A typed array is JSON-serializable as {"0":1,"1":2,...}, which turns a
  // megabyte buffer into a megabyte of log. Its size is the only useful part.
  if (ArrayBuffer.isView(value)) {
    return `[${value.constructor.name}: ${value.byteLength} bytes]`;
  }

  if (seen.has(value)) return { '[Circular]': 'circular reference detected' };
  if (depth > options.maxDepth) {
    return `[TRUNCATED: max depth ${options.maxDepth}]`;
  }

  // Added for the descent and removed after it, so `seen` tracks the current
  // path rather than every object ever visited. A value reachable twice through
  // different keys is shared, not circular, and must serialize both times.
  seen.add(value);
  try {
    if (Array.isArray(value)) return sanitizeArray(value, options, seen, depth);
    if (value instanceof Map) return fromMap(value, options, seen, depth);
    if (value instanceof Set) {
      return { '[Set]': sanitizeArray([...value], options, seen, depth) };
    }
    return sanitizeObject(
      value as Record<string, unknown>,
      options,
      seen,
      depth,
    );
  } finally {
    seen.delete(value);
  }
};

export const sanitizeLogEntry = (
  entry: LogEntry,
  options: SanitizeOptions,
): LogEntry => sanitizeObject(entry, options, new WeakSet<object>([entry]), 0);

/**
 * The first `Error` anywhere in the value, so `log({ result: { cause: err } })`
 * still reports a stack instead of an opaque object.
 *
 * `seen` is never cleared here, unlike in the sanitizer: this is a search, and a
 * subtree already searched cannot start containing an error.
 */
/** Matches LoggerOptions.maxDepth's default, for callers that pass no options. */
const DEFAULT_MAX_DEPTH = 32;

/**
 * Bounded as well as cycle-safe. The `WeakSet` stops a cycle, but this walk runs on
 * the caller's object *before* sanitization, so the sanitizer's own depth cap never
 * applied to it — a deep acyclic chain overflowed the stack from inside a log call.
 * Node's stack is smaller than Bun's, so `bun test` alone does not catch it.
 */
export const findNestedError = (
  value: unknown,
  maxDepth: number = DEFAULT_MAX_DEPTH,
  seen: WeakSet<object> = new WeakSet<object>(),
  depth = 0,
): Error | null => {
  if (value instanceof Error) return value;
  if (typeof value !== 'object' || value === null) return null;
  if (depth > maxDepth) return null;
  if (seen.has(value)) return null;
  seen.add(value);

  const next = depth + 1;

  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findNestedError(item, maxDepth, seen, next);
      if (found) return found;
    }
    return null;
  }

  for (const [, entry] of safeEntries(value as Record<string, unknown>)) {
    const found = findNestedError(entry, maxDepth, seen, next);
    if (found) return found;
  }
  return null;
};
