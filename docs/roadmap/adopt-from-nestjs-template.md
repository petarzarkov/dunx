# Adopt what is good from nestjs-template

**Ongoing.** The owner spent months on `/home/petarzarkov/repos/nestjs-template`
and rates it. Treat it as a source of proven patterns.

## Adopted

- **Merging Better Auth's OpenAPI schema into the app document.** Done, with four
  deliberate differences from the original: a declared route wins a collision
  rather than being overwritten, the fragment type is loose because a foreign
  library's operations cannot satisfy dunx's strict `OperationObject`, a missing
  `openAPI()` plugin contributes nothing rather than throwing, and `@dunx/auth`
  restates the fragment shape structurally so it does not depend on
  `@dunx/openapi`. The mechanism is general: anything mounting its own handler can
  contribute.
- **One log entry per request, carrying request and response together.** Adopted
  earlier from the template's `RequestMiddleware` plus `HttpLoggingInterceptor`,
  and simplified: dunx needs one middleware because middleware wraps `next()`.
- **`ConfigService` with a single validation function**, and the `as` subclass that
  keeps the type through a factory's `inject`.

## Still to mine

The template port in `/home/petarzarkov/repos/dunx-template` is reading the whole
thing and will surface candidates. Areas worth a look:

- Swagger UI preauthorization: the template hooks the sign-in response and calls
  `preauthorizeApiKey` so the explorer is authenticated after a login. The dunx
  explorer has an Authorize dialog but does not do this.
- `env-vars.md` as a generated document.
- The e2e layout, and `docker-compose.full.yml` versus `docker-compose.yml`.
- `scripts/` and `lint-staged.config.mjs`.
