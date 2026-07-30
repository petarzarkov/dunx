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
  ContextStore,
  DEFAULT_MASK_FIELDS,
  type LoggerConfig,
} from '@arkv/logger';
export {
  LoggerModule,
  LoggerSettings,
  type LoggerConfigSource,
} from './module.js';
