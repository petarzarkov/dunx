# Versioning

Turn on versioning and give a controller a version. Under URI versioning each
version is its own `Bun.serve` route key, so a request pays nothing to be
versioned.

```ts
import { Controller, Deprecated, Get, HttpFactory, Version } from '@dunx/http';

@Deprecated({ since: '2026-09-01', sunset: '2027-03-01' })
@Controller('users', { version: '1' })
export class UsersV1Controller {
  @Get(':id') // GET /api/v1/users/:id
  one() {}
}

@Controller('users', { version: '2' })
export class UsersV2Controller {
  @Get(':id') // GET /api/v2/users/:id
  one() {}

  @Version(['2', '3'])
  @Get('') // GET /api/v2/users and GET /api/v3/users
  list() {}
}

const app = await HttpFactory.create(AppModule, {
  prefix: 'api',
  versioning: { type: 'uri' },
});
```

`HttpOptionsProvider` has a `versioning` getter for the same setting.

## Options

| `type`         | Also takes | The version is                                  |
| -------------- | ---------- | ----------------------------------------------- |
| `'uri'`        | `prefix`   | A path segment, `/v1/users`. `prefix` is `'v'`  |
| `'header'`     | `header`   | One request header's value: `X-API-Version: 2`  |
| `'media-type'` | `key`      | An `Accept` parameter: `key: 'v='` reads `;v=2` |

All three take `defaultVersion`, the version or versions of a route that
declares none. Absent, such a route stays unversioned.

Versioning is off by default. With it off, a route that declares a version is a
boot error naming the handler.

## Which version a route gets

| Declared                              | Served at                                         |
| ------------------------------------- | ------------------------------------------------- |
| `@Version('2')` on the handler        | `/v2/...`, whatever the controller says           |
| `@Controller(path, { version: '1' })` | `/v1/...` for every handler without `@Version`    |
| An array, `['1', '2']`, on either     | One route per version                             |
| `VERSION_NEUTRAL` on either           | The unversioned path, even under `defaultVersion` |
| Nothing, with `defaultVersion: '1'`   | `/v1/...`                                         |
| Nothing, with no `defaultVersion`     | The unversioned path                              |

The global prefix goes in front: `/api/v1/users`. `strict: false` aliases
`/api/v1/users/` too. CORS, `csrf` and `securityHeaders` wrap a versioned route
as they wrap any other.

`HealthController`, the OpenAPI document and page, and the `@dunx/auth` mount are
`VERSION_NEUTRAL`. Middleware serving its own paths (`StaticFiles`, the
dashboard, RPC) is never versioned.

The same path and method under two controllers is a boot error, as it is without
versioning.

## Header and media-type versioning

```ts
HttpFactory.create(AppModule, {
  versioning: { type: 'header', header: 'X-API-Version', defaultVersion: '2' },
});
// or: { type: 'media-type', key: 'v=' } for Accept: application/json;v=2
```

Every version of a path and method shares one `Bun.serve` route key. That
entry reads the header once and picks the handler from a map built at boot,
which costs 0.6 to 0.75 us a request.

| Request                                                    | Answered by                                            |
| ---------------------------------------------------------- | ------------------------------------------------------ |
| Names a version the path has                               | That version's handler                                 |
| Names no version                                           | `defaultVersion`'s handler                             |
| Names an unknown version, or none with no `defaultVersion` | A `VERSION_NEUTRAL` handler on the same path, else 404 |

The 404 is the app's own, through its global middleware, as for any unmatched
path. Nest answers the same way: a version that matches no handler calls
`next()` and ends at its 404.

- Every response from a versioned entry appends `Vary: X-API-Version`, or
  `Vary: Accept` for media type. An unversioned path is untouched.
- A CORS preflight admits the version header. With `allowedHeaders` omitted it
  echoes the request's; a fixed list has the header added.
- Guards, `@Idempotent`, `@Deprecated`, CSRF and security headers apply to the
  version that answered. Only a deprecated version's responses carry
  `Deprecation`.
- `Accept` is split on `,` and `;`, and the first parameter starting with `key`
  wins, in any media range. The parameter name is matched case-insensitively.
- An empty header or parameter value names no version.
- `header` must be a valid header name, and a `defaultVersion` entry a
  non-empty string, or `HttpFactory.create` throws.

## Deprecation

`@Deprecated` goes on a handler or a controller; a handler's replaces its
controller's. Every response from the route, mapped errors included, carries:

| Header        | From     | Format                                            | Example                                                         |
| ------------- | -------- | ------------------------------------------------- | --------------------------------------------------------------- |
| `Deprecation` | `since`  | Structured Field Date, [RFC 9745][rfc9745]        | `@1788220800`                                                   |
| `Sunset`      | `sunset` | HTTP-date, [RFC 8594][rfc8594]                    | `Mon, 01 Mar 2027 00:00:00 GMT`                                 |
| `Link`        | `link`   | `rel="deprecation"`, RFC 9745 section 3, appended | `<https://example.com/v1>; rel="deprecation"; type="text/html"` |

`since` is required: RFC 9745 only allows a date as the `Deprecation` value.
Pass a `Date` or a string `new Date()` can parse; a date-only string means
midnight UTC. The class throws when it is defined if a date does not parse, if
`sunset` is before `since` (RFC 9745 section 4 forbids it), or if `link` is not
a URL.

`Deprecation` and `Sunset` are set only where the handler did not set its own.
`Link` is appended, so a handler's pagination `Link` keeps both. The headers are
computed once when the server binds; a route without `@Deprecated` is not
wrapped.

A browser reading these cross-origin needs them in the CORS `exposedHeaders`.

## OpenAPI

Under URI versioning one document lists every version, each operation under the
path it is served at. A handler serving two versions is two operations, with
the version in the `operationId`: `UsersV2Controller_list_v2` and
`UsersV2Controller_list_v3`. An unversioned route keeps `Controller_handler`.

With header or media-type versioning, every version shares the same paths.
OpenAPI 3.1 allows one operation per path and method, so each version gets its own
document, holding that version's routes plus every unversioned route.

| URL                       | Serves                                                    |
| ------------------------- | --------------------------------------------------------- |
| `/openapi.json`           | The `defaultVersion` document, else the highest version's |
| `/openapi.json?version=1` | Version 1's document                                      |
| `/docs?version=1`         | The explorer page for version 1                           |
| `?version=` of no version | 404                                                       |

The page shows a row of links, one per version, above Swagger UI or Scalar. The
row is plain HTML, so the page's script hash does not change. Swagger UI's own
`urls` dropdown is not used: it needs Swagger UI's standalone layout, a second
1 MiB bundle that `SwaggerRenderer` does not serve. A custom renderer gets the
same links in `PageOptions.versions`.

A header-versioned operation declares the header as a parameter whose `const`
is its version, optional for the default version. Media type declares nothing:
OpenAPI ignores a header parameter named `Accept`.

`@Deprecated` marks the operation `deprecated: true`, the same as
`@ApiDoc({ deprecated: true })`.

`@dunx/openapi` reads the app's `versioning` setting. The offline CLI cannot see
`HttpOptions`, so if the app versions by anything other than plain `'uri'`, pass
`versioning` in the `openapi` export. `apiVersion` picks which version's
document to write:

```ts
export const openapi = {
  root: AppModule,
  versioning: { type: 'header', header: 'X-API-Version' },
  apiVersion: '1', // absent writes the one /openapi.json serves
};
```

`bunx @dunx/mcp` reads `versioning` from the same export, so its route list and
document match what the app serves.

## Coming from NestJS

| NestJS                                 | dunx                                        |
| -------------------------------------- | ------------------------------------------- |
| `app.enableVersioning({ type: URI })`  | `versioning: { type: 'uri' }`               |
| `@Controller({ path, version })`       | `@Controller(path, { version })`            |
| `@Version('2')`, `VERSION_NEUTRAL`     | The same names                              |
| `defaultVersion`                       | The same, without a `VERSION_NEUTRAL` value |
| `VersioningType.HEADER`, `{ header }`  | `{ type: 'header', header }`                |
| `VersioningType.MEDIA_TYPE`, `{ key }` | `{ type: 'media-type', key }`               |
| `VersioningType.CUSTOM`                | Not supported                               |

A request naming no version gets `defaultVersion` here; Nest serves it only a
`VERSION_NEUTRAL` handler. See the
[NestJS versioning docs](https://docs.nestjs.com/techniques/versioning).

[rfc9745]: https://www.rfc-editor.org/rfc/rfc9745.html
[rfc8594]: https://www.rfc-editor.org/rfc/rfc8594.html
