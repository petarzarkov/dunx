# OpenAPI

`@dunx/openapi` builds an OpenAPI 3.1 document out of the schemas the routes
already validate against, and serves it. A documentation UI over it is opt-in:
Swagger UI behind `@dunx/openapi/swagger`, Scalar behind `@dunx/openapi/scalar`.

Each request is described once. The zod schema on `@Post('/', createUser)`
validates the request, and the generator reads the same object. There are no
separate annotations that could disagree with what the server enforces.

```ts
import { HttpFactory } from '@dunx/http';
import { OpenApiModule } from '@dunx/openapi';
import { SwaggerRenderer } from '@dunx/openapi/swagger';

const app = await HttpFactory.create(
  OpenApiModule.forRoot({
    title: 'dunx full example',
    version: '0.1.0',
    description:
      'Generated from the same zod schemas the routes validate against.',
    root: AppModule,
    renderer: new SwaggerRenderer(),
  }),
);
```

The page it produces is at
[demo.dunx.win/api/docs](https://demo.dunx.win/api/docs), generated from that
example's own schemas.

`forRoot` **wraps** the root it documents and returns it, so `HttpFactory.create`
is still handed one module ref and the root is named once.

Its own routes - the page, the document and the page's assets - are `@ApiHidden()`.
They are real routes, discovered like any controller's, but the document describes
the API rather than the thing serving it, so a generated client does not arrive
with a `getOpenapiJson()` on it.

| Option        | Default         | Meaning                                    |
| ------------- | --------------- | ------------------------------------------ |
| `title`       | required        | `info.title`                               |
| `version`     | required        | `info.version`                             |
| `description` | none            | `info.description`                         |
| `servers`     | none            | `servers[]`                                |
| `root`        | required        | The module graph to document and to import |
| `renderer`    | none            | The documentation UI. None serves no page  |
| `path`        | `/docs`         | Where the HTML page is mounted             |
| `jsonPath`    | `/openapi.json` | Where the document is mounted              |

The document carries a strong `ETag`, hashed once per prefix and version, and
answers a matching `If-None-Match` with a 304 whether or not the app sets `etag`.

Use `forRootAsync({ root, useFactory, inject })` to read the options from
validated config. The factory returns every option except `root`:

```ts
OpenApiModule.forRootAsync({
  root: AppModule,
  useFactory: (config: AppConfigService) => ({
    title: config.get('app').name,
    version: config.get('app').version,
    path: config.get('app').docsPath,
  }),
  inject: [AppConfigService],
});
```

`root` and `renderer` go next to the factory, not inside it. The module graph and
the explorer's routes are built before the container exists, so there is nothing
yet to run the factory.

`path` and `jsonPath` can come from the factory. Route paths are read after every
provider is built, so the factory has already run by then.

zod is an **optional** `peerDependency`. Install it and schemas convert; do not,
and the document still generates with warnings where the schemas would have been.

## What the generator reads

`describeRoutes(root)` walks the module graph and returns exactly what
`discoverRoutes` produced for the server, so the document describes the table that
is actually served. From each route it reads:

- `options.body`, `options.query`, `options.params` - the Standard Schema objects.
- `options.status` - the success status, following the same rule `buildRoutes`
  applies: an explicit status, else 201 for POST, else 200.
- `options.response` - the Standard Schema per status code the route answers with.
- `meta` and `classMeta` - whatever `@Public`, `@Roles`, `@ApiDoc` and
  `@Idempotent` wrote. `@Idempotent` adds the `Idempotency-Key` header and its
  400, 409 and 422 ([Idempotency](./33-idempotency.md#openapi)).
- the path and the method, from the verb decorator.

You can write the document to a file from a script, with no container and no
server. `describeRoutes` reads each controller's prototype and never constructs
it, so no dependency has to exist:

```ts
import { describeRoutes, generateDocument } from '@dunx/openapi';

const { document, warnings } = await generateDocument(
  describeRoutes(AppModule),
  {
    title: 'API',
    version: '1.0.0',
  },
);
await Bun.write('openapi.json', JSON.stringify(document, null, 2));
```

### Paths, operations and tags

- `/users/:id` becomes `/users/{id}`. Bun matches the first form, OpenAPI templates
  the second.
- `operationId` is `Controller_handler`, for example `UsersController_one`. A
  versioned route appends its version, `UsersController_one_v2`, and is listed
  at its versioned path; `@Deprecated` marks it `deprecated`. See
  [Versioning](./34-versioning.md).
- The tag is the controller's name with a trailing `Controller` stripped, so
  `UsersController` documents itself as `Users`. `@ApiDoc({ tags })` overrides it.
- The document's top-level `tags` list is read back off the **operations**, so it
  declares exactly the tags they carry. Deriving it separately from the class names
  let a document declare tags nothing used and use tags it never declared, which
  puts a viewer's sidebar at odds with its own operation list.
- Path parameters are driven by the **path** rather than the schema. OpenAPI requires
  every path parameter to appear in the template, so a schema property that is not
  a path token is not a path parameter. A token with no matching schema property
  is documented as a required `string`.
- Query parameters are expanded one per property, with `required` taken from the
  schema's own `required` list. A `$ref` cannot be split into `parameters`
  entries, so a query schema's root object is read rather than referenced.
- Ordering is deterministic. Paths sort by code unit rather than `localeCompare`,
  because a generated document has to come out byte-identical on every machine and
  collation is locale dependent: ICU sorts `/reports/{id}` before
  `/reports/health`, and a machine without ICU sorts it after.

### The 400 every validating route can produce

Any route that declares a `body`, `query` or `params` schema gets a documented
`400` referencing a `ValidationError` component:

```json
{
  "error": "Invalid body",
  "status": 400,
  "issues": [{ "message": "...", "path": "name" }]
}
```

This is the body `@dunx/http`'s default error mapper sends when validation fails.

### Response bodies

`options.response` is keyed by status code and takes the same Standard Schema
values the request side takes:

```ts
export const oneUser = {
  params: UserIndex,
  response: { 200: SanitizedUser, 404: NotFound },
} as const satisfies RouteSchemas;
```

A response schema with `.meta({ id })` is added to `components/schemas`, and the
operation points to it with a `$ref`, the same as a request body. Client
generators rely on this.

- Response schemas are converted with **`io: 'output'`**: a field with a default
  is always present, and objects get `additionalProperties: false`. Request
  schemas use `io: 'input'`. A schema used both ways is converted twice, and if
  the two results differ, one `.meta({ id })` cannot name both.
- **Responses are never validated.** The schema only documents the response. See
  [Validation](./06-validation.md#routeschemas).

A status listed only here is still documented, so a `404` that a handler throws
appears in the document with no other annotation. The success status keeps its
own description and gains the `content`.

### Names in the explorer

A hoisted schema gets a `title` equal to its `components/schemas` key, unless it
declared one of its own.

Explorers use that title to label **nested** schemas. Without it, Swagger UI shows
a list of users as `array<object>` instead of `array<User>`.

Put prose in `description`. A sentence in `title` is what a reader sees instead of
the type name, and the Schemas list becomes unbrowsable.

### A plain JSON Schema

`response` also takes a JSON Schema object, which needs no conversion:

```ts
const Pong = Object.freeze({
  $id: 'Pong',
  type: 'object',
  properties: { pong: { type: 'boolean' } },
  required: ['pong'],
});

@Get('/ping', { response: { 200: Pong } })
```

With `$id`, the schema is added to `components/schemas` under that name and
referenced with a `$ref`, like `.meta({ id })` on a zod schema. The `$id` key
itself is removed from the definition. Without `$id`, the schema is inlined.

This is the response side only. `body`, `query` and `params` are parsed, so they
need a validator.

`@dunx/http` documents `/health/live` and `/health/ready` this way: it has no
validator dependency, and `HEALTH_REPORT_SCHEMA` is exported, so an app mounting the
probes on its own paths can reference the same definition.

## `@ApiDoc`

Schemas describe shape. They cannot describe intent, grouping or deprecation, so
`@ApiDoc` carries the prose:

```ts
@ApiDoc({
  tags: ['notes'],
  description: 'A list in memory, for showing the prefix, middleware and CORS.',
})
@Controller('notes')
export class NotesController {
  @ApiDoc({
    summary: 'Echo the caller’s address',
    description: 'Reads the socket address, honouring `x-forwarded-for`.',
    deprecated: true,
  })
  @Get('/whoami')
  whoami({ req }: Input<RouteSchemas>): { ip: string | undefined } {
    return { ip: this.address.of(req) };
  }
}
```

| Field         | Type       | Notes                                          |
| ------------- | ---------- | ---------------------------------------------- |
| `summary`     | `string`   | One line.                                      |
| `description` | `string`   | Markdown, rendered server side.                |
| `tags`        | `string[]` | Overrides the tag derived from the class name. |
| `deprecated`  | `boolean`  | Only `true` is emitted.                        |

It works at class scope and at method scope, and the two **compose per field**.
The operation above is tagged and described from the class, then summarised and
deprecated from the method; the method wins only on a field they both set.

Class tags plus per-method summaries therefore need no repetition, and dropping
the class `tags` from a method does not silently fall back to the class-name
default.

`@ApiDoc` stores its value with `@dunx/http`'s route metadata (`metaKey` and
`meta`), like any other route decorator. See
[Middleware and guards](./08-middleware-and-guards.md#route-metadata).

One difference: `RouteContext.get` returns the method's value if there is one, so
a method value **replaces** the class value. That suits `@Roles`. `@ApiDoc` merges
field by field instead, so a `DiscoveredRoute` also carries the class's own value
in `classMeta`, next to the merged `meta`.

## Security comes from the guards' own metadata

The document reads the same `@Public()` and `@Roles()` that the guards read at
runtime, so the two cannot drift. There is no separate `@ApiBearerAuth`
decorator to keep in sync:

| Route declares     | Operation gets                                                  |
| ------------------ | --------------------------------------------------------------- |
| `@Public()`        | `security: []`, an explicit empty requirement                   |
| `@Roles('editor')` | `security: [{ bearer: [] }]` and `x-required-roles: ['editor']` |
| neither            | nothing, so it inherits any document-level default              |

The description gains a line too: `Requires one of these roles: \`editor\`.`

`components.securitySchemes.bearer` is added only when some route declares roles.
Its description reads:

> Whatever the guards in front of these routes accept. dunx does not ship an
> authentication scheme - this documents that a guard is there.

Note the consequence of reading metadata rather than guards: a class-level
`@Roles('admin')` is merged into every route on that class and therefore
documented on all of them, **even where no guard reads it**. The document
describes what the metadata declares; which guard enforces it is a separate
decision, and one no generator can see. If that gap matters, install the guard.

## Who may read the document

`authorize` decides whether a request sees the explorer at all: the document, the
page, and the page's own assets, one decision covering all three. It is the same
`Authorize` `@dunx/dashboard` takes, so one function gates both ops surfaces.

```ts
OpenApiModule.forRoot({
  title: 'Payments',
  version: '1.4.0',
  root: AppModule,
  renderer: new SwaggerRenderer(),
  authorize: (req) =>
    req.headers.get('x-docs-token') === process.env.DOCS_TOKEN,
});
```

Without `authorize`, anyone can read the document, and boot does not warn about it
(the dashboard does). Set it when the document should stay private, for example
when it lists admin operations and their `x-required-roles`.

Three things follow from where it runs.

**It receives the raw `BunRequest`.** The explorer's routes are `@Public()`, so no
guard has established the caller and nothing upstream has written a context. Ask
the auth library:

```ts
authorize: async (req) =>
  (await auth.api.getSession({ headers: req.headers })) !== null,
```

That closes over an `Auth` the container owns, so it comes out of
`forRootAsync`'s factory rather than sitting beside `root`.

**A refusal answers 404**, with the same body as an unknown path, so a caller
cannot tell a gated explorer from a missing one.

**A returned `Response` is sent as written.** A browser arrives with a cookie and
no way to attach a bearer token, so a 404 leaves a person nowhere to go:

```ts
authorize: async (req) => {
  if (await signedIn(req)) return true;
  return req.headers.get('accept')?.includes('text/html') === true
    ? new Response(null, { status: 302, headers: { location: '/sign-in' } })
    : false;
},
```

Check something the page's asset requests also send, such as a cookie. A query
parameter is not sent with the stylesheet and script requests, so they are refused
and the page renders blank.

To gate a second renderer that you mount yourself, write a middleware that calls
`gate(authorize, req)` from `@dunx/http` with the same function. `OpenApiModule`
and `DashboardMiddleware` both use it. It returns the response to send, or
`undefined` to continue. `examples/full/src/docs-gate.ts` does this for Swagger UI
at `/api/docs` and Scalar at `/api/reference`.

## Naming a schema with `.meta({ id })`

zod puts nested definitions under `$defs`. The generator moves them to
`components/schemas` and rewrites `#/$defs/Tag` to `#/components/schemas/Tag`.
`.meta({ id })` is the only annotation you add:

```ts
export const Tag = z
  .object({ label: z.string().min(1) })
  .meta({ id: 'Tag', title: 'A label attached to a user' });

export const CreateUser = z
  .object({
    name: z.string().min(1).max(40),
    tags: z.array(Tag).default([]),
  })
  .meta({ id: 'CreateUser', title: 'Create a user' });
```

- `id` names a `components/schemas` entry, and the request body becomes
  `{ "$ref": "#/components/schemas/CreateUser" }`. The `Tag` definition it
  referenced comes along with it.
- `title` lands inline on the schema, as a human label.
- A schema with no `id` is **inlined** where it is used, which suits a one-off
  body.
- A **self-referential** schema is always moved to `components/schemas`, with or
  without an `id`. zod writes the cyclic ref as `#` ("this schema"), which would
  point at the wrong place inside a larger document.

An `id` on a query or params schema usually creates no component, because those
schemas are expanded into `parameters`. A self-referential one still does.

`danglingRefs(document)` is exported and worth running on any generated document:
a `$ref` that resolves to nothing renders as an empty box in every viewer and
reports no error at all. The generator runs it on its own output as a canary and
adds a warning if it ever fires.

## The vendor check

Standard Schema only covers validation. It has no way to turn a schema into JSON
Schema, so the generator converts per library, based on the `vendor` field:

```ts
const vendor = schema['~standard'].vendor;
if (vendor !== 'zod') { ... }
```

zod is the vendor implemented, through
`z.toJSONSchema(schema, { io: 'input', unrepresentable: 'any' })`:

- `io: 'input'` describes the **request**: a field with a default is optional,
  and objects do not get `additionalProperties: false`.
- `unrepresentable: 'any'` turns a `Date` or a `bigint` into an unconstrained
  schema instead of failing the whole document.

zod is imported **dynamically**, and only once a zod schema has actually turned
up, so a consumer on Valibot never loads it and a consumer without it installed
gets warnings rather than a module-resolution crash at import time.

Any other library's schema is documented as permissive, with a warning:

```
UsersController_createBody: no JSON Schema conversion for Standard Schema vendor
"valibot". Standard Schema validates; it does not describe. The schema is
documented as permissive.
```

The operation also carries `x-schema-vendor` so the gap is visible in the document
itself. Every warning is readable straight after boot:

```ts
const app = await HttpFactory.create(OpenApiModule.forRoot({ ... }));
console.log(app.get(OpenApiExplorer).warnings);
```

`OpenApiExplorer` is built by an **async** factory, so the whole document,
including every schema conversion, is generated during boot. The warnings are
there as soon as `create` returns.

## The page

The document is served with or without a page. A page is a `renderer`, and there
is no default: with none, `/openapi.json` is the only route the module adds.

| Renderer          | Subpath                 | Optional peer           | Install              | Assets, gzipped |
| ----------------- | ----------------------- | ----------------------- | -------------------- | --------------- |
| `SwaggerRenderer` | `@dunx/openapi/swagger` | `swagger-ui-dist`       | 12 MB, 2 packages    | 447 KiB         |
| `ScalarRenderer`  | `@dunx/openapi/scalar`  | `@scalar/api-reference` | 276 MB, 279 packages | 1.05 MiB        |

```ts
import { OpenApiModule } from '@dunx/openapi';
import { SwaggerRenderer } from '@dunx/openapi/swagger';

OpenApiModule.forRoot({
  title: 'Payments',
  version: '1.4.0',
  root: AppModule,
  // Or: new ScalarRenderer({ theme: 'purple' }) from '@dunx/openapi/scalar'
  renderer: new SwaggerRenderer({ docExpansion: 'list' }),
});
```

Install the one you mount: `bun add swagger-ui-dist` or
`bun add @scalar/api-reference`. Without it the page route throws, with a message
naming the package and the command; `/openapi.json` is unaffected.

`renderer` sits beside `root` rather than inside `forRootAsync`'s factory, because
the controller declares its routes before there is a container to run a factory.

Each constructor takes that library's own configuration, plus the `title` and
`favicon` dunx owns. `SwaggerUiOptions` is every Swagger UI parameter; the seven
that are functions take the source of an expression (`RawJs`) instead, since a
server-rendered page cannot carry a closure. `ScalarOptions` is Scalar's
configuration without its function-valued keys.

### What the page fetches

The document travels in the page, in a `<script type="application/json">` the boot
script parses. Nothing fetches `/openapi.json`, so the page works where that route
is guarded differently.

The renderer's files are fetched, same-origin, as siblings of the page:

| Renderer   | Files                                                                               |
| ---------- | ----------------------------------------------------------------------------------- |
| Swagger UI | `swagger-ui-bundle.js`, `swagger-ui.css`, `swagger-ui.css.map`, `favicon-32x32.png` |
| Scalar     | `standalone.js`, `standalone.js.map`                                                |

**No CDN.** Every `src` and `href` the page emits is relative, which both
renderers' tests assert against the rendered markup. Scalar's default web fonts
are `fonts.scalar.com`, so `withDefaultFonts` defaults to `false`; set it to `true`
to take them.

A name off that list answers 404 rather than reading from disk. One wildcard route
serves the files, and both packages hold other builds and megabytes of sourcemaps
in the same directory. The two `.map` files are served because the assets that
reference them would otherwise log a 404 in a browser with devtools open.

Assets carry `cache-control: public, max-age=31536000, immutable` and the installed
version in the query, so an upgrade busts the cache with no path change.

The page needs JavaScript. A `<noscript>` block links the raw document.

`OpenApiExplorer` caches the rendered page per mount prefix, since
`setGlobalPrefix()` is applied after the container is built. The renderer resolves
its files on the first request for the page, so an app serving only the document
never looks them up.

### A renderer of your own

Extend `DocsRenderer` and implement its two methods, `page` and `asset`. Two
helpers do most of the work. `renderShell` builds the same HTML page the built-in
renderers use. `PackageAssets` serves files from an installed package, but only
the files you list, so the wildcard asset route cannot serve anything else:

```ts
import {
  DocsRenderer,
  PackageAssets,
  readDocument,
  renderShell,
  type AssetPackage,
  type OpenApiDocument,
  type PageOptions,
} from '@dunx/openapi';

const ASSETS: AssetPackage = {
  name: 'my-explorer',
  directory: 'dist',
  files: { 'explorer.js': 'text/javascript; charset=utf-8' },
};

export class MyRenderer extends DocsRenderer {
  async page(doc: OpenApiDocument, options: PageOptions): Promise<string> {
    const assets = await PackageAssets.resolve(ASSETS);
    return renderShell(doc, {
      mountId: 'explorer',
      jsonHref: options.jsonHref,
      scripts: [assets.href(options.mountedAt, 'explorer.js')],
      // `readDocument` declares the embedded document as a variable.
      boot: `${readDocument('spec')}Explorer.mount('#explorer', spec);`,
    });
  }

  asset(name: string): Promise<Response> {
    // Checks the allow-list before it resolves the package, so a junk name off
    // the wildcard route is a 404 and costs nothing.
    return PackageAssets.serve(ASSETS, name);
  }
}
```

## Sharp edges

- **`forRoot` imports the `root` you pass it.** Do not import it again yourself;
  boot fails with a duplicate-binding error.
- **A non-object schema for `query` or `params` documents nothing** and produces
  a warning: a query string is a set of named parameters, and there is nothing to
  expand.
- **A response schema is checked by the compiler, never at runtime.** The verb
  decorator constrains the handler's return type to `response[<success status>]`,
  so a handler answering with another shape is a `TS1241` naming the mismatched
  property. Nothing validates a response body per request. Declaring a plain
  JSON Schema instead of a Standard Schema turns the check off for that route:
  there is no type to infer from it.
- **A schema used in both directions converts twice**, with `io: 'input'` for the
  request and `io: 'output'` for the response. If the two views differ - anything
  with a `.default()` - one `.meta({ id })` cannot name both, and the store keeps
  the first and warns.
- **`x-required-roles` is an extension** rather than standard OpenAPI, so a
  reader can see the roles without parsing the description sentence.
- **A class-level `@Roles` documents every route on that class**, whether or not
  a guard reads it there.
- **The document describes the mounted paths**, `setGlobalPrefix` included, but
  gateway paths are not in it: OpenAPI has no representation for a WebSocket
  upgrade. See [WebSockets](./09-websockets.md).

Next: [Testing](./11-testing.md).
