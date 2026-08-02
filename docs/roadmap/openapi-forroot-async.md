# `HttpOptions` is evaluated before the container that would configure it

**Missing feature. Medium.**

`HttpOptions` is an argument to `HttpFactory.create`, which is the call that
_builds_ the container, so `requestLogging`, `onError` and `middleware` cannot read
validated config. Middleware is registered by class, never by instance, so NestJS's
`app.useGlobalInterceptors(new X(config))` after `app.get(ConfigService)` has no
counterpart.

Workaround in the template: call `validateConfig(Bun.env)` a second time in
`main.ts` before `create()`. It is pure so it cannot disagree with itself, and it
costs one extra zod parse - but it means config is validated twice and the second
call is invisible to the container.

The fix needs a decision: either a post-create hook that can still install
middleware, or accepting that anything needing config has to be resolved from the
container by a middleware that takes it as a constructor dependency.

The `OpenApiModule.forRoot`-only half of this file is **done**:
`OpenApiModule.forRootAsync({ root, useFactory, inject })` produces `title`,
`version`, `description`, `servers`, `path` and `jsonPath` from a factory that may
inject. The mount paths work because `@Get` now takes a `RoutePath` thunk, resolved
at route discovery, which runs after every provider has settled.
