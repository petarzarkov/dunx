/**
 * Frozen object plus an indexed-access union, not an `enum` — see CLAUDE.md and
 * `@dunx/http`'s `HttpStatusCode`. One exported name serves as both the value
 * (`LogLevel.DEBUG`) and the type (`level: LogLevel`), and it erases cleanly
 * instead of emitting a runtime object with reverse mappings.
 */
export const LogLevel = Object.freeze({
  VERBOSE: 'verbose',
  DEBUG: 'debug',
  LOG: 'log',
  WARN: 'warn',
  ERROR: 'error',
  FATAL: 'fatal',
} as const);
export type LogLevel = (typeof LogLevel)[keyof typeof LogLevel];

/** Ascending severity. Position in this array is what `level` filtering compares. */
export const LOG_LEVELS = Object.freeze([
  LogLevel.VERBOSE,
  LogLevel.DEBUG,
  LogLevel.LOG,
  LogLevel.WARN,
  LogLevel.ERROR,
  LogLevel.FATAL,
] as const);

/** Levels at which a bare string or `{ error: string }` is promoted to an `Error`. */
const ERROR_LEVELS: readonly LogLevel[] = [
  LogLevel.WARN,
  LogLevel.ERROR,
  LogLevel.FATAL,
];

export const isErrorLevel = (level: LogLevel): boolean =>
  ERROR_LEVELS.includes(level);

/**
 * The per-async-flow fields merged into every entry. Held in an
 * `AsyncLocalStorage` by `ContextStore`, never in the container.
 */
export interface AsyncContext {
  requestId?: string;
  userId?: string;
  orgId?: string;
  method?: string;
  event?: string;
  context?: string;
  flow?: string;
  [key: string]: unknown;
}

export interface LoggerConfig {
  name?: string;
  version?: string;
  env?: string;
  /** @default LogLevel.DEBUG */
  level?: LogLevel;
  /** Defaults to `process.env.NODE_ENV !== 'production'` */
  isDevelopment?: boolean;
  /**
   * Force coloured output on or off. Defaults to `isDevelopment` **and**
   * `Bun.enableANSIColors`, so a pipe, a non-TTY or `NO_COLOR` yields plain JSON
   * without any escape sequences.
   */
  colors?: boolean;
  /** Merged with DEFAULT_MASK_FIELDS */
  maskFields?: string[];
  /** Events to skip logging for */
  filterEvents?: string[];
  /**
   * Truncate arrays beyond this length.
   *
   * @default 100
   */
  maxArrayLength?: number;
  /**
   * Stop descending past this nesting depth. A cycle is already caught by
   * reference, but an acyclic structure thousands of levels deep would still
   * overflow the stack inside a log call.
   *
   * @default 32
   */
  maxDepth?: number;
}

/** An `Error` flattened to something `JSON.stringify` keeps. */
export interface SerializedError {
  name: string;
  message: string;
  stack?: string;
}

export type LogEntry = Record<string, unknown> & {
  error?: Error | SerializedError;
};

export const DEFAULT_MASK_FIELDS = Object.freeze([
  'password',
  'secret',
  'token',
  'authorization',
  'cookie',
  'apiKey',
  'apiSecret',
  'apiPass',
] as const);
