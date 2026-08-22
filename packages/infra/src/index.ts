/**
 * Every area in full, with **three** exceptions: `/db`, `/queue` and `/pagination`.
 *
 * The rule, so which barrel has a symbol is never a guess: if an area is here at
 * all, all of it is here.
 *
 * `/db` and `/queue` are absent for the same reason, and it is the one that
 * matters: each reaches an **optional peer** through a static import, so
 * re-exporting either would make that peer a hard requirement of
 * `import '@dunx/infra'` for every consumer. bullmq's own entry point imports
 * `ioredis`; `/db` imports `drizzle-orm`. Reach them at `@dunx/infra/db` and
 * `@dunx/infra/queue`. `packages/infra/src/index.test.ts` holds both halves of
 * that to account.
 *
 * `/pagination` is absent for no stated reason, which is drift rather than a
 * decision: it has no peer of its own and predates this note. Adding it changes a
 * published surface, so it is recorded here rather than fixed in passing.
 *
 * `/schedule` **is** here. Its only externals are `@dunx/core` and the first-party
 * `@arkv/timezones`, a hard dependency, so it obliges a consumer to install
 * nothing.
 *
 * The subpaths are still the better import: they say what a file uses, and they
 * evaluate only the peers that area needs.
 */
export {
  defaultRedisUrl,
  isConnectionError,
  isServerError,
  type MessageListener,
  REDIS_PROTOCOLS,
  type RedisArg,
  redisConnection,
  RedisConnection,
  RedisError,
  RedisErrorCode,
  type RedisKey,
  RedisModule,
  RedisOptions,
  type RedisOptionsInit,
  type RedisProtocol,
  type RedisValue,
  type ScanOptions,
  type ScanResult,
  type SetOptions,
} from './redis/index.js';
export {
  FileNotFoundError,
  FilesModule,
  type FileStat,
  type ListEntry,
  type ListOptions,
  LocalStorage,
  LocalStorageOptions,
  PathTraversalError,
  type PresignOptions,
  S3Storage,
  S3StorageOptions,
  Storage,
  StorageError,
  StorageOptions,
  UnsupportedOperationError,
  type WriteData,
} from './files/index.js';
export {
  defaultImagesOptions,
  EncodableFormat,
  type EncodedImage,
  type EncodeOptionsFor,
  ImageError,
  ImageErrorCode,
  ImageFit,
  ImageFormat,
  type ImageMetadata,
  ImagePipeline,
  Images,
  type ImagesConfig,
  ImagesModule,
  ImagesOptions,
  type ImagesOptionsInput,
  type ImageSource,
  isEncodableFormat,
  isImageFormat,
  type JpegOptions,
  mimeTypeOf,
  type ModulateOptions,
  type PngOptions,
  type QualityOptions,
  readSource,
  ResizeFilter,
  type ResizeOptions,
  sniffFormat,
  toImageError,
  type WebpOptions,
} from './images/index.js';
export * from './logger/index.js';
export {
  Cron,
  CronExpression,
  Interval,
  OnceOnBoot,
  Overlap,
  ScheduleEntry,
  ScheduleError,
  ScheduleErrorCode,
  ScheduleKind,
  ScheduleModule,
  ScheduleOptions,
  ScheduleRegistry,
  supportsTz,
  type CronDecoratorOptions,
  type ScheduleMeta,
  type ScheduleOptionsInit,
  type TimerDecoratorOptions,
} from './schedule/index.js';
