import { Logger, LOG_LEVELS, RequestContext, type LogLevel } from '@dunx/core';

/**
 * Three answers to "what if the entry were not JSON", each a drop-in `Logger` for
 * the `default` row so a comparison against it is one variable.
 *
 * They share `ConsoleLogger`'s batching verbatim - one write per event-loop turn -
 * because `bun run logging` already measured that the write dominates anything
 * these change. Batching them differently would measure the batching.
 */
let pending = '';
let scheduled = false;

const flushPending = (): void => {
  scheduled = false;
  if (pending === '') return;
  const batch = pending;
  pending = '';
  console.log(batch);
};

export const emitLine = (line: string): void => {
  pending = pending === '' ? line : `${pending}\n${line}`;
  if (scheduled) return;
  scheduled = true;
  setTimeout(flushPending, 0).unref();
};

let stampAt = 0;
let stampValue = '';
export const timestamp = (): string => {
  const now = Date.now();
  if (now !== stampAt) {
    stampAt = now;
    stampValue = new Date(now).toISOString();
  }
  return stampValue;
};

const PID = process.pid;
const MINIMUM = LOG_LEVELS.indexOf('info');

/**
 * Quote, backslash and the C0 range: everything a JSON string has to escape. The
 * control range is the point of the check, and a native `RegExp.test` is what makes
 * the escape-only-when-dirty variants worth measuring, so the rule is off here
 * rather than the range being written some slower way.
 */
// oxlint-disable-next-line no-control-regex
const DIRTY = /["\\\u0000-\u001f]/;

/** `JSON.stringify` only when the value can carry something needing an escape. */
const str = (value: string): string =>
  DIRTY.test(value) ? JSON.stringify(value) : `"${value}"`;

/**
 * The level dispatch every variant below shares. `#line` is the only difference
 * between them, which is the point of the comparison.
 */
abstract class FormatLogger extends Logger {
  readonly logLevel: LogLevel = 'info';

  constructor(protected readonly context: RequestContext) {
    super();
  }

  verbose(message: unknown, ...rest: unknown[]): void {
    this.#write('verbose', message, rest);
  }
  debug(message: unknown, ...rest: unknown[]): void {
    this.#write('debug', message, rest);
  }
  info(message: unknown, ...rest: unknown[]): void {
    this.#write('info', message, rest);
  }
  log(message: unknown, ...rest: unknown[]): void {
    this.#write('info', message, rest);
  }
  warn(message: unknown, ...rest: unknown[]): void {
    this.#write('warn', message, rest);
  }
  error(message: unknown, ...rest: unknown[]): void {
    this.#write('error', message, rest);
  }
  fatal(message: unknown, ...rest: unknown[]): void {
    this.#write('fatal', message, rest);
  }

  protected abstract format(
    level: LogLevel,
    message: string,
    fields: Record<string, unknown> | undefined,
  ): string;

  #write(level: LogLevel, message: unknown, rest: readonly unknown[]): void {
    if (LOG_LEVELS.indexOf(level) < MINIMUM) return;
    emitLine(
      this.format(
        level,
        typeof message === 'string' ? message : String(message),
        rest[0] as Record<string, unknown> | undefined,
      ),
    );
  }
}

/**
 * The control, and the row every other one here must be read against:
 * `ConsoleLogger`'s own line-building - merge both bags into an entry object, hand
 * it to `JSON.stringify` - on this file's dispatch and batching.
 *
 * Without it a comparison against the shipped `default` row also carries the
 * difference between the two dispatches, which is not what any of this is about.
 */
export class MergeLogger extends FormatLogger {
  protected override format(
    level: LogLevel,
    message: string,
    fields: Record<string, unknown> | undefined,
  ): string {
    return JSON.stringify({
      level,
      timestamp: timestamp(),
      pid: PID,
      message,
      ...this.context.getContext(),
      ...fields,
    });
  }
}

/**
 * logfmt instead of JSON, and otherwise `ConsoleLogger` unchanged: it still
 * assembles the merged entry, because a generic logger cannot know the shape.
 * This is the row that answers "text instead of JSON" as a formatter swap.
 */
const textValue = (value: unknown): string => {
  if (typeof value === 'string') {
    return DIRTY.test(value) || value.includes(' ')
      ? JSON.stringify(value)
      : value;
  }
  if (value === null || value === undefined) return '-';
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  return JSON.stringify(value) ?? '-';
};

export class TextLogger extends FormatLogger {
  protected override format(
    level: LogLevel,
    message: string,
    fields: Record<string, unknown> | undefined,
  ): string {
    const entry: Record<string, unknown> = {
      level,
      timestamp: timestamp(),
      pid: PID,
      message,
      ...this.context.getContext(),
      ...fields,
    };
    let out = '';
    for (const key in entry) out = `${out}${key}=${textValue(entry[key])} `;
    return out;
  }
}

/**
 * Byte-identical JSON to `ConsoleLogger`, built without merging the two bags into
 * an entry object first: each is serialised by native `JSON.stringify` and spliced
 * in with its braces removed.
 *
 * A key present in both bags would appear twice rather than being overridden, so
 * this is a measurement rather than a shippable logger.
 */
const bag = (obj: Record<string, unknown> | undefined): string => {
  if (obj === undefined) return '';
  const text = JSON.stringify(obj);
  return text.length > 2 ? `,${text.slice(1, -1)}` : '';
};

export class NoMergeLogger extends FormatLogger {
  protected override format(
    level: LogLevel,
    message: string,
    fields: Record<string, unknown> | undefined,
  ): string {
    return (
      `{"level":"${level}","timestamp":"${timestamp()}","pid":${PID},` +
      `"message":${str(message)}` +
      `${bag(this.context.getContext())}${bag(fields)}}`
    );
  }
}

/**
 * The request-logging entry's shape written out longhand: the five scope fields
 * the middleware puts in the store, then the three it passes as fields, with
 * anything unexpected spliced in generically so no entry is silently dropped.
 *
 * Every string goes through `str`, including the four that in practice cannot hold
 * a quote. Interpolating them raw was faster and emitted invalid JSON for any value
 * that did, which would have made this row's output differ from the contract it is
 * being compared against.
 *
 * This is the ceiling the format experiment is really asking about - no merged
 * entry object, no per-key dispatch, one template literal.
 */
const KNOWN_SCOPE = ['traceId', 'method', 'event', 'flow', 'context'];
const KNOWN_FIELDS = ['request', 'statusCode', 'elapsedMs'];

const rest = (
  obj: Record<string, unknown>,
  known: readonly string[],
): string => {
  let extra: Record<string, unknown> | undefined;
  for (const key in obj) {
    if (known.includes(key)) continue;
    extra ??= {};
    extra[key] = obj[key];
  }
  return bag(extra);
};

export class FastJsonLogger extends FormatLogger {
  protected override format(
    level: LogLevel,
    message: string,
    fields: Record<string, unknown> | undefined,
  ): string {
    const scope = this.context.getContext();
    const request = fields?.['request'];
    return (
      `{"level":"${level}","timestamp":"${timestamp()}","pid":${PID},` +
      `"message":${str(message)},` +
      `"traceId":${str(String(scope.traceId ?? ''))},` +
      `"method":${str(String(scope.method ?? ''))},` +
      `"event":${str(String(scope.event ?? ''))},` +
      `"flow":${str(String(scope.flow ?? ''))},` +
      `"context":${str(String(scope.context ?? ''))},` +
      `"request":${request === undefined ? '{}' : JSON.stringify(request)},` +
      `"statusCode":${Number(fields?.['statusCode'] ?? 0)},` +
      `"elapsedMs":${Number(fields?.['elapsedMs'] ?? 0)}` +
      `${rest(scope, KNOWN_SCOPE)}${fields === undefined ? '' : rest(fields, KNOWN_FIELDS)}}`
    );
  }
}

/**
 * The pino technique: a serialiser compiled once for the shape the entry actually
 * has, so a request pays no key iteration, no `Array.includes` guard and no merged
 * entry object. `FastJsonLogger` above writes the same line by hand but keeps a
 * `for...in` guard for unexpected keys; this row exists to say what that guard
 * costs and what codegen is worth without it.
 *
 * The shape is fixed at construction, which is what a compiled serialiser trades:
 * a key outside `SCOPE_KEYS` or `FIELD_KEYS` is dropped rather than appended.
 */
const val = (value: unknown): string => {
  if (typeof value === 'string') return str(value);
  if (typeof value === 'number')
    return Number.isFinite(value) ? `${value}` : 'null';
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'boolean') return `${value}`;
  return JSON.stringify(value) ?? 'null';
};

type Compiled = (
  level: string,
  message: string,
  scope: Record<string, unknown>,
  fields: Record<string, unknown> | undefined,
) => string;

const SCOPE_KEYS = ['traceId', 'method', 'event', 'flow', 'context'];
const FIELD_KEYS = ['request', 'statusCode', 'elapsedMs', 'err'];

const compile = (
  scopeKeys: readonly string[],
  fieldKeys: readonly string[],
): Compiled => {
  const lines = [
    `var out = '{"level":"' + level + '","timestamp":"' + stamp() + '","pid":' + PID + ',"message":' + str(message);`,
    'var v;',
  ];
  for (const key of scopeKeys) {
    lines.push(
      `v = scope.${key}; if (v !== undefined) out += ',"${key}":' + val(v);`,
    );
  }
  lines.push('if (fields !== undefined) {');
  for (const key of fieldKeys) {
    lines.push(
      `v = fields.${key}; if (v !== undefined) out += ',"${key}":' + val(v);`,
    );
  }
  lines.push('}');
  lines.push(`return out + '}';`);

  // oxlint-disable-next-line no-new-func, no-implied-eval
  const factory = new Function(
    'str',
    'val',
    'stamp',
    'PID',
    `return function (level, message, scope, fields) {\n${lines.join('\n')}\n};`,
  ) as (
    s: typeof str,
    v: typeof val,
    t: typeof timestamp,
    p: number,
  ) => Compiled;
  return factory(str, val, timestamp, PID);
};

const compiled = compile(SCOPE_KEYS, FIELD_KEYS);

export class AotLogger extends FormatLogger {
  protected override format(
    level: LogLevel,
    message: string,
    fields: Record<string, unknown> | undefined,
  ): string {
    return compiled(level, message, this.context.getContext(), fields);
  }
}

/**
 * Takes the same `(message, ...rest)` signature the `Logger` contract has and
 * throws the arguments away.
 *
 * The ladder's `entry-discard` and `entry-stamp` rows use loggers whose `info()`
 * declares no parameters at all, so they never allocate the rest array that every
 * real level method does. Without this row between them, that allocation is
 * charged to serialisation.
 */
export class RestOnlyLogger extends Logger {
  readonly logLevel: LogLevel = 'info';

  verbose(message: unknown, ...rest: unknown[]): void {
    this.#write(message, rest);
  }
  debug(message: unknown, ...rest: unknown[]): void {
    this.#write(message, rest);
  }
  info(message: unknown, ...rest: unknown[]): void {
    this.#write(message, rest);
  }
  log(message: unknown, ...rest: unknown[]): void {
    this.#write(message, rest);
  }
  warn(message: unknown, ...rest: unknown[]): void {
    this.#write(message, rest);
  }
  error(message: unknown, ...rest: unknown[]): void {
    this.#write(message, rest);
  }
  fatal(message: unknown, ...rest: unknown[]): void {
    this.#write(message, rest);
  }

  #write(message: unknown, rest: readonly unknown[]): void {
    if (LOG_LEVELS.indexOf('info') < MINIMUM) return;
    sinkCount += rest.length + (message === undefined ? 1 : 0);
  }
}

let sinkCount = 0;
export const restSink = (): number => sinkCount;

/**
 * Two rows that separate producing the line from producing a *long* line.
 *
 * `AssembleLogger` builds the merged entry object and stops, so the difference to
 * a row that also serialises is the string and nothing else. `ShortLogger`
 * serialises a three-key entry to about 40 bytes rather than 250. If the cost of
 * the step tracks the length of the line, what is being paid for is the
 * allocation, and no amount of faster formatting reaches it.
 */
export class AssembleLogger extends FormatLogger {
  protected override format(
    level: LogLevel,
    message: string,
    fields: Record<string, unknown> | undefined,
  ): string {
    held = {
      level,
      timestamp: timestamp(),
      pid: PID,
      message,
      ...this.context.getContext(),
      ...fields,
    };
    return '';
  }
}

export class ShortLogger extends FormatLogger {
  protected override format(
    level: LogLevel,
    message: string,
    _fields: Record<string, unknown> | undefined,
  ): string {
    return JSON.stringify({ level, message });
  }
}

let held: unknown;
export const heldEntry = (): unknown => held;

/**
 * The same request, logged with the fields that are not already somewhere else.
 *
 * The shipped entry carries the method, the path and the status three times over:
 * `message` is already "GET /json 200", and `method`, `event` and `statusCode`
 * repeat it. `flow` is the constant 'http', `pid` is constant for the process, and
 * `context` names the handler the path already identifies. Dropping the repeats
 * takes the line from about 250 bytes to about 120.
 *
 * Nothing about this is a faster formatter. It is the same `JSON.stringify` over
 * half as much.
 */
export class LeanLogger extends FormatLogger {
  protected override format(
    level: LogLevel,
    message: string,
    fields: Record<string, unknown> | undefined,
  ): string {
    const scope = this.context.getContext();
    return JSON.stringify({
      level,
      timestamp: timestamp(),
      message,
      traceId: scope.traceId,
      elapsedMs: fields?.['elapsedMs'],
    });
  }
}

/**
 * Between `LeanLogger` and the shipped entry: everything a log pipeline filters or
 * groups on is kept, and only what cannot be queried usefully is dropped.
 *
 * Out go `pid`, constant for the life of the process; `flow`, the constant 'http';
 * and `request.userAgent`, which is a header the caller chooses and the longest
 * single field on the line. `method`, `event`, `context`, `traceId`,
 * `statusCode` and `elapsedMs` stay, so nothing that a query selects on is lost.
 */
export class TrimLogger extends FormatLogger {
  protected override format(
    level: LogLevel,
    message: string,
    fields: Record<string, unknown> | undefined,
  ): string {
    const scope = this.context.getContext();
    return JSON.stringify({
      level,
      timestamp: timestamp(),
      message,
      traceId: scope.traceId,
      method: scope.method,
      event: scope.event,
      context: scope.context,
      statusCode: fields?.['statusCode'],
      elapsedMs: fields?.['elapsedMs'],
    });
  }
}
