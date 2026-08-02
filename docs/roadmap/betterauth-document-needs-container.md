# betterAuthDocument's own usage example cannot run

**Missing feature. Medium-high.** Found by porting `dunx-template`.

The doc comment shows:

```ts
OpenApiModule.forRoot({
  title: 'API',
  contribute: [betterAuthDocument(auth, { basePath: '/api/auth' })],
});
```

`forRoot` is evaluated while the module graph is being described, before
`HttpFactory.create` builds the container, and `OpenApiExplorer`'s factory
declares no `inject`. So there is nowhere for `auth` to come from: the contributor
thunk has no container to resolve `Auth` out of.

The template works around it by building a **second, database-less `betterAuth()`**
from the same pure options object purely to generate the schema. That is a real
cost - the options have to be factored into something callable twice - and it is
not what the example implies.

## Fix

Either:

1. **`OpenApiModule.forRootAsync({ useFactory, inject })`**, matching
   `LoggerModule`, `ImagesModule`, `RedisModule`, `FilesModule` and `DbModule`.
   Consistent with the rest of the framework, and this is the exact problem
   `forRootAsync` exists to solve elsewhere. See
   [openapi-forroot-async](./openapi-forroot-async.md), which wants it anyway.
2. A `betterAuthDocument(options)` overload taking the _options_ rather than the
   instance, since the schema is derivable from them.

(1) is preferred: it fixes the general case, and the second roadmap item is
already asking for it.
