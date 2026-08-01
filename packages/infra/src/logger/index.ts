// The injectable contract lives in @dunx/core so that package stays
// dependency-free and @dunx/http middleware can inject Logger without pulling
// anything in. Re-exported here so a consumer needs one import.
export {
  isErrorLevel,
  LOG_LEVELS,
  Logger,
  LogLevel,
  type LogEntry,
  type LogMessage,
  type SerializedError,
} from '@dunx/core';
// The implementation's own surface. dunx restates none of it.
export {
  type CaptureGlobalErrorsOptions,
  captureGlobalErrors,
  ConsoleTransport,
  type ConsoleTransportOptions,
  ContextStore,
  DEFAULT_MASK_FIELDS,
  FileTransport,
  type FileTransportOptions,
  jsonFormat,
  type LogFormatter,
  type LoggerConfig,
  prettyFormat,
  RESERVED_CONFLICTS_KEY,
  RESERVED_ENTRY_KEYS,
  type RotationInterval,
  type RunWithContextOptions,
  type Transport,
} from '@arkv/logger';
export {
  BackingLogger,
  LoggerModule,
  type LoggerConfigSource,
  type LoggerModuleOptions,
  LoggerSettings,
} from './module.js';
