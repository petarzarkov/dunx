# OpenAPI

`@dunx/openapi` builds an OpenAPI 3.1 document out of the schemas the routes
already validate against, and serves it. A documentation UI over it is opt-in:
Swagger UI behind `@dunx/openapi/swagger`, Scalar behind `@dunx/openapi/scalar`.

The point is that there is **one** description of a request in the codebase. The
zod schema on `@Post('/', createUser)` is the object the request path calls
`~standard.validate` on, and it is the same object the generator reads. Nothing is
reconstructed from reflection, and there is no annotation that can disagree with
what the server enforces.

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
| `renderer`    | none            | The documentation UI. None serves no page  |
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

`root` and `renderer` stay outside the factory. The graph must exist before the
container that would run the factory does, and the controller declares its routes
in the same breath.

The mount paths escape that. The controller declares its routes with **path
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

`DocsRenderer` is two methods. `renderShell` is the markup both renderers produce,
and `PackageAssets` serves a package's files out of the consumer's install, gated
on the allow-list that makes the wildcard route safe:

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
