# Nothing evaluated before the container can read validated config

**Missing feature. Medium.** Two instances of one shape.

- **`OpenApiModule` has `forRoot` only.** `LoggerModule`, `DbModule`, `RedisModule`,
  `FilesModule`, `ImagesModule` and `QueueModule` all have `forRootAsync` precisely
  so their options can come off `ConfigService`. So `title`, `version`,
  `description`, `path` and `jsonPath` cannot.
- **`HttpOptions` is an argument to `HttpFactory.create`,** which is the call that
  _builds_ the container, so `requestLogging`, `onError` and `middleware` cannot read
  config either. Middleware is registered by class, never by instance, so
  NestJS's `app.useGlobalInterceptors(new X(config))` after `app.get(ConfigService)`
  has no counterpart.

Workaround in the template: call `validateConfig(Bun.env)` a second time in
`main.ts` before `create()`. It is pure so it cannot disagree with itself, and it
costs one extra zod parse - but it means config is validated twice and the second
call is invisible to the container.

`forRootAsync` on `OpenApiModule` is the easy half. The `HttpOptions` half needs a
decision: either a post-create hook that can still install middleware, or accepting
that anything needing config has to be resolved from the container by a middleware
that takes it as a constructor dependency.
