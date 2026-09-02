// The concrete class, exported so an app can subclass it for a named connection:
// `class SessionsRedis extends Redis {}` handed to `RedisModule.forRoot(init, as)`.
// `RedisConnection` is abstract and takes no options, so it cannot be the base.
export { Redis } from './client.js';
export {
  RedisConnection,
  type MessageListener,
  type RedisArg,
  type RedisKey,
  type RedisValue,
  type ScanOptions,
  type ScanResult,
  type SetOptions,
} from './connection.js';
export {
  isConnectionError,
  isServerError,
  RedisError,
  RedisErrorCode,
} from './errors.js';
export {
  RedisModule,
  redisConnection,
  type ConnectionTarget,
} from './module.js';
export {
  defaultRedisUrl,
  REDIS_PROTOCOLS,
  RedisOptions,
  type RedisOptionsInit,
  type RedisProtocol,
} from './options.js';
