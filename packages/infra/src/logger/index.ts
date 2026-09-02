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
// The implementation's own surface. dunx restates none of it, which is what keeps
// a new transport upstream reachable here by adding a name rather than a wrapper.
// `StreamTransport` was missing from this list and unreachable through the subpath
// despite shipping, which is the failure mode a hand-written re-export has.
export {
  BatchTransport,
  type BatchedEntry,
  type BatchTransportOptions,
  type CaptureGlobalErrorsOptions,
  captureGlobalErrors,
  ConsoleTransport,
  type ConsoleTransportOptions,
  ContextStore,
  DEFAULT_MASK_FIELDS,
  FileTransport,
  type FileTransportOptions,
  HttpDeliveryError,
  HttpTransport,
  type HttpTransportOptions,
  jsonFormat,
  logfmtFormat,
  type LogFormatter,
  type LoggerConfig,
  prettyFormat,
  RESERVED_CONFLICTS_KEY,
  RESERVED_ENTRY_KEYS,
  type RotationInterval,
  type RunWithContextOptions,
  SamplingTransport,
  type SamplingOptions,
  StreamTransport,
  type StreamTransportOptions,
  type SyslogProtocol,
  SyslogTransport,
  type SyslogTransportOptions,
  textFormat,
  type Transport,
  type TransportStats,
} from '@arkv/logger';
export {
  BackingLogger,
  LoggerModule,
  type LoggerConfigSource,
  type LoggerModuleOptions,
  LoggerSettings,
} from './module.js';
