# OpenAPI

`@dunx/openapi` builds an OpenAPI 3.1 document out of the schemas the routes
already validate against, and serves a self-contained explorer page for it.

The point is that there is **one** description of a request in the codebase. The
zod schema on `@Post('/', createUser)` is the object the request path calls
`~standard.validate` on, and it is the same object the generator reads. Nothing is
reconstructed from reflection, and there is no annotation that can disagree with
what the server enforces.

```ts
import { HttpFactory } from '@dunx/http';
import { OpenApiModule } from '@dunx/openapi';

const app = await HttpFactory.create(
  OpenApiModule.forRoot({
    title: 'dunx full example',
    version: '0.1.0',
    description:
      'Generated from the same zod schemas the routes validate against.',
    root: AppModule,
  }),
);
```

`forRoot` **wraps** the root it documents and returns it, so `HttpFactory.create`
is still handed one module ref and the root is named once. That is also why the
document describes the documentation routes: they are routes, and pretending
otherwise would be the first lie in the file.

| Option        | Default         | Meaning                                    |
| ------------- | --------------- | ------------------------------------------ |
| `title`       | required        | `info.title`                               |
| `version`     | required        | `info.version`                             |
| `description` | none            | `info.description`                         |
| `servers`     | none            | `servers[]`                                |
| `root`        | required        | The module graph to document and to import |
| `path`        | `/docs`         | Where the HTML page is mounted             |
| `jsonPath`    | `/openapi.json` | Where the document is mounted              |

`forRootAsync({ root, useFactory, inject })` is the same module with everything but
`root` produced by a factory, which is how any of the above comes off validated
config:

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

`root` stays outside the factory because it is a module reference: the graph must
exist before the container that would run the factory does.

The mount paths escape that. The controller declares its two routes with **path
thunks**, and route discovery runs after every provider has settled, so the
factory that produced a path has returned before anything reads it. `RoutePath`
in `@dunx/http` is the type.

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
- `meta` and `classMeta` - whatever `@Public`, `@Roles` and `@ApiDoc` wrote.
- the path and the method, from the verb decorator.

A document can be written to a file from a script with no container and no
server, because `describeRoutes` never constructs a controller.

`discoverRoutes` walks an instance's prototype chain looking for marked
methods, and `Object.create(Controller.prototype)` is that chain with nothing
behind it: `instance.constructor` still resolves to the class, every method is
still reachable, and no constructor, or dependency of one, has to exist:

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
- `operationId` is `Controller_handler`, for example `UsersController_one`.
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

That is the framework's real error shape, from `defaultErrorMapper` and the issue
flattening in the input reader. Documenting it beats leaving a caller to discover
it from a failing request.

### Response bodies

`options.response` is keyed by status code and takes the same Standard Schema
values the request side takes:

```ts
export const oneUser = {
  params: UserIndex,
  response: { 200: SanitizedUser, 404: NotFound },
} as const satisfies RouteSchemas;
```

One contract covers both directions: a named response schema hoists into
`components/schemas` and the operation `$ref`s it exactly as a request body does.
That gives `.meta({ id })` on a response-only schema its meaning, and gives the
document what it needs for client codegen.

Two consequences of it being the same contract rather than a second channel:

- The response side is converted with **`io: 'output'`**, because it describes what
  comes back: a field with a default is always present there, and
  `additionalProperties: false` is an output-side claim. The request side keeps
  `io: 'input'`. A schema used both ways therefore converts twice, and if the two
  views differ, one `.meta({ id })` cannot name both.
- **It is never validated.** See
  [Validation](./06-validation.md#routeschemas): documenting a response is not
  enforcing it, and paying a validation pass per response for a documentation
  feature would be the wrong trade.

A status the route does not otherwise mention is documented from this key alone, so
a `404` a handler throws is in the document without a second annotation. The
declared success status keeps its own description and gains the `content`.

### Names in the explorer

A hoisted schema gets a `title` equal to its `components/schemas` key, unless it
declared one of its own.

An explorer labels a **nested** schema by that title. Swagger UI renders a model as
`title || displayName || name`: a `$ref` at the root of a response supplies those
fallbacks from the ref, but the same `$ref` inside `items` supplies neither, so
`array<User>` read as `array<object>` before the title was there.

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

`$id` hoists it into `components/schemas` and leaves a `$ref`, the way
`.meta({ id })` does for a zod schema, and is stripped from the definition. Without
one it is inlined.

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
  whoami(input: Input<RouteSchemas>): { ip: string | undefined } {
    return { ip: this.address.of(input.req) };
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

`@ApiDoc` is otherwise a thin wrapper over `@dunx/http`'s generic route-metadata
channel: `metaKey` mints a unique symbol and `meta` writes it. No parallel
registry, no second discovery pass. See
[Middleware and guards](./08-middleware-and-guards.md#route-metadata).

Documentation differs from that mechanism in one place. `RouteContext.get`
resolves a key handler-first-then-class, **replacing** the class's value, which
suits `@Roles` and breaks a value made of independent fields. Composing the two
needs the class's own record, so a `DiscoveredRoute` carries `classMeta` next to
the merged `meta`.

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

`components.securitySchemes.bearer` is added only when some route declares roles,
and it is honest about what it means:

> Whatever the guards in front of these routes accept. dunx does not ship an
> authentication scheme - this documents that a guard is there.

Note the consequence of reading metadata rather than guards: a class-level
`@Roles('admin')` is merged into every route on that class and therefore
documented on all of them, **even where no guard reads it**. The document
describes what the metadata declares; which guard enforces it is a separate
decision, and one no generator can see. If that gap matters, install the guard.

## Naming a schema with `.meta({ id })`

zod emits nested definitions under `$defs`. OpenAPI calls that slot
`components/schemas`. Hoisting and rewriting `#/$defs/Tag` to
`#/components/schemas/Tag` is the whole difference between the two, and
`.meta({ id })` is the only annotation this package asks for:

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
- A **self-referential** schema is hoisted whether or not it has an `id`. zod emits
  a cyclic ref as `#`, meaning "this schema", which is true where zod emitted it
  and false once it is one entry among many; hoisting is what gives the ref a place
  to point at.

Query and params schemas are expanded into `parameters` rather than referenced, so
an `id` on one of those normally creates no component. A cyclic one still does.

`danglingRefs(document)` is exported and worth running on any generated document:
a `$ref` that resolves to nothing renders as an empty box in every viewer and
reports no error at all. The generator runs it on its own output as a canary and
adds a warning if it ever fires.

## The vendor check

Standard Schema **validates**. It says nothing about describing, and there is no
vendor-neutral way to turn a schema into JSON Schema. So conversion is per vendor,
gated on the one piece of vendor information the interface carries:

```ts
const vendor = schema['~standard'].vendor;
if (vendor !== 'zod') { ... }
```

zod is the vendor implemented, through
`z.toJSONSchema(schema, { io: 'input', unrepresentable: 'any' })`:

- `io: 'input'` is what a **request** looks like. A field with a default is
  optional going in and present coming out, and `additionalProperties: false` is
  an output-side claim.
- `unrepresentable: 'any'` because a `Date` or a `bigint` in one schema must not
  take the whole document down.

zod is imported **dynamically**, and only once a zod schema has actually turned
up, so a consumer on Valibot never loads it and a consumer without it installed
gets warnings rather than a module-resolution crash at import time.

Anything else degrades to a permissive schema plus a warning. Claiming to have
documented a body that was never read would be worse than saying so:

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

`OpenApiExplorer` is bound by an **async** `useFactory`, so the whole document,
every schema conversion included, is settled before the first constructor runs.
A degraded document is visible at boot rather than at the moment somebody notices
an empty request body in the explorer.

## The page

`GET /docs` is one self-contained HTML document: a boot `<style>`, the model in a
`<script type="application/json">`, and the explorer bundle in a second
`<script>`. **Nothing is fetched.** No CDN, no `src=`, no `<link>`, no webfont, no
external image.

That guarantee ruled out `swagger-ui-dist` (11.7 MB unpacked, and a CDN in
practice) and `@scalar/api-reference` (11 MB). It is asserted by the package's own
tests, which boot the real bundle and check that it issues zero fetches.

The explorer is a React and Mantine frontend, bundled at build time and inlined
into the page as a string. Importing `@dunx/openapi` does not load it; see
[What the page costs](#what-the-page-costs).

What the page does that a static rendering cannot:

- **Sends requests.** Every operation is executable, the usual reason people
  reach for swagger-ui.
- **Credentials once.** An **Authorize** dialog reads
  `components.securitySchemes` and offers a field per scheme, applied to every
  operation that declares it and kept in the tab's `sessionStorage`.
- **Path parameters are substituted.** Every `{name}` in the template gets an
  input whether or not the document declares it, so a request can never go out
  with a literal `{id}` in it.
- **The body arrives pre-filled** from the schema, with refs resolved and
  `minimum` and `format` honoured.

Two Bun APIs do work a dependency usually would: `Bun.escapeHTML` escapes the
shell, and `Bun.markdown.html` renders every description **on the server**, with
`noHtmlBlocks`, `noHtmlSpans` and `tagFilter` on, so raw HTML in a schema
description is escaped rather than trusted and no markdown parser lands in the
bundle. Request samples are pre-computed server side too.

`OpenApiExplorer` caches by mount prefix, because `setGlobalPrefix()` is applied
after the container is built. The request path only serialises a string that
already exists.

The page needs JavaScript, which the hand-written page it replaced did not. A
`<noscript>` block links the raw document.

### What the page costs

The explorer is a React bundle: **437 KiB raw, 123 KiB gzipped**, of which React
is 188 KiB. The served page is about 458 KiB, or ~125 KiB gzipped.

**Importing `@dunx/openapi` does not load it.** `renderPage` lives behind the
`@dunx/openapi/ui` subpath and `OpenApiExplorer.page()` reaches it with
`await import()` on the first request for the page, caching the rendered string
per mount prefix. A service that never serves `/docs` pays 19.8 KB and ~5.7 ms of
import, against 479.6 KB and ~10.9 ms when the bundle was inlined.

To avoid it entirely, do not mount the page. `OpenApiModule` still serves
`/openapi.json`, and pointing your own swagger-ui or Scalar at it is one route.
`buildModel` and `renderShell` are exported so a page of your own can reuse the
pre-rendered prose, the samples and the fields.

## Sharp edges

- **The `root` you pass to `forRoot` is also what gets imported.** Do not import
  it separately as well; the container's duplicate-binding check will say so.
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
