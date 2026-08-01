// The better-auth instance and the request principal. `Auth` is the injection
// token; `Principal` is whatever `auth.api.getSession()` resolves to.
export { Auth, type Principal } from './auth.js';
export { AuthContext } from './context.js';
export { AuthError } from './errors.js';
export { rolesOf, SessionGuard } from './guard.js';
export { AuthHandler, mountHandler } from './handler.js';
export { AuthModule } from './module.js';
export {
  AuthOptions,
  DEFAULT_BASE_PATH,
  normalizeBasePath,
} from './options.js';
export { bunPassword } from './password.js';
// `secondaryStorage` over `Bun.RedisClient`. It stays on the main entry because it
// imports nothing at runtime — unlike `@dunx/auth/drizzle`, which pulls
// better-auth's drizzle adapter and therefore `drizzle-orm` in behind it.
export { redisStorage, type RedisStore } from './redis.js';
