# @dunx/openapi

An OpenAPI 3.1 document generated from the routes an app already has, with
**Swagger UI** served from the same `Bun.serve` as everything else.

The difference from a reflection-based generator is what it reads. A route's
schemas are the objects the request path validates against. Its security
metadata (`@Public()`, `@Roles()`) is what its guards enforce. Both are already
on the route, so the document is not a second description that can drift from
the first.

## Install

```bash
bun add @dunx/openapi zod
```

`zod` is a peer dependency. Route validation targets Standard Schema, so Valibot
and ArkType work for validation too, but the OpenAPI document needs JSON Schema,
and only zod has `z.toJSONSchema`. A non-zod schema validates at runtime and
appears as a permissive entry in the document, with a warning at generation time.

`swagger-ui-dist` is a regular dependency - nobody writes code against it, so
nobody has a version opinion about it.

## Usage

```ts
import { HttpFactory } from '@dunx/http';
import { OpenApiModule } from '@dunx/openapi';

const app = await HttpFactory.create(
  OpenApiModule.forRoot({
    title: 'Payments',
    version: '1.4.0',
    root: AppModule, // the graph to document, and the graph that gets imported
  }),
);
app.setGlobalPrefix('api');
await app.listen(3000);
// GET /api/docs          the explorer
// GET /api/openapi.json  the document
```

`forRootAsync` takes a factory that may inject, so an app can read its title off
`ConfigService` or contribute another library's schema.

## What is here

The [OpenAPI guide](../../docs/guide/10-openapi.md) is canonical.

| Piece                | What it does                                                        |
| -------------------- | -------------------------------------------------------------------- |
| `OpenApiModule`      | Wraps the root it documents, mounts the page and the JSON            |
| `@ApiDoc`            | Summary, description, tags and deprecation on a route or a class     |
| `@ApiHidden`         | A real route kept out of the document. Lives in `@dunx/http`         |
| `describeRoutes`     | The routes as data, constructing nothing                             |
| `generateDocument`   | The document from those routes                                       |
| `betterAuthDocument` | better-auth's own paths merged in. Lives in `@dunx/auth`             |
| `bunx dunx-openapi`  | The document written to a file, with no container and no server      |

Security comes from the same `@Public()` and `@Roles()` metadata the guards read
at runtime, so there is no second annotation for the document to disagree with.
A response schema is documentation only: the verb decorators hold the handler's
return type to it at compile time instead of validating every response.

## Notes

- `.meta({ id })` on a zod schema is what hoists it into `components/schemas`.
  Without an id it is inlined at every use site. `.strict()` after `.meta()`
  discards the metadata, so put `.meta()` last.
- Prose belongs in `description`. Swagger UI labels a schema by `title`, which
  `@dunx/openapi` fills with the component name.
- The page embeds the document rather than fetching it, and loads its two assets
  same-origin. Nothing reaches a CDN.

## License

MIT
