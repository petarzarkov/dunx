# @dunx/openapi

An OpenAPI 3.1 document generated from the routes an app already has, and a docs
page served from the same `Bun.serve` as everything else. Zero dependencies beyond
`@dunx/core` and `@dunx/http`; no `swagger-ui-dist`, no `@scalar/*`, no template
engine, no HTTP client.

The difference from a reflection-based generator is what it reads. A route's
schemas are objects the request path validates against, and its metadata is what
its guards enforce. Both are already on the route, so the document is not a second
description that can drift from the first — it is the first one, rendered.

```ts
import { HttpFactory } from '@dunx/http';
import { OpenApiModule } from '@dunx/openapi';

const app = await HttpFactory.create(
  OpenApiModule.forRoot({
    title: 'Payments',
    version: '1.4.0',
    root: AppModule, // the graph to document — and the graph that gets imported
  }),
);
app.setGlobalPrefix('api');
await app.listen(3000);
// GET /api/openapi.json   the document
// GET /api/docs           the page
```

`forRoot` returns a `DynamicModule` that imports the root it documents, so
`HttpFactory.create()` is still handed exactly one module ref. What it adds is one
controller with two `@Public()` `GET` routes — mounted, discovered, guarded,
middleware-wrapped and CORS-wrapped like any other. Nothing is bolted onto the
server behind the app's back, which is also why the docs routes appear in the
document: they are routes.

| Option        | Default          | Effect                                    |
| ------------- | ---------------- | ----------------------------------------- |
| `title`       | —                | `info.title`                              |
| `version`     | —                | `info.version`                            |
| `description` | —                | `info.description`, rendered as markdown  |
| `servers`     | —                | `servers`, verbatim                       |
| `root`        | —                | The module graph to document              |
| `path`        | `/docs`          | Where the HTML page is mounted            |
| `jsonPath`    | `/openapi.json`  | Where the document is mounted             |

## zod is a peerDependency, and that is the point

Bun ships no schema API, so validation is the one place dunx cannot satisfy its
own native-only rule. The resolution is that the framework's contract is
**Standard Schema** — an interface, restated at zero dependency cost — and the one
place a vendor-specific API is genuinely needed is here:

```ts
if (schema['~standard'].vendor === 'zod') // z.toJSONSchema
```

Standard Schema v1 has no JSON Schema export. It validates; it does not describe.
So conversion is per vendor, behind that check, and zod is the vendor implemented.
It is imported **dynamically**, on first sight of a zod schema — an app on Valibot
never loads it, and one without it installed gets warnings rather than a
module-resolution crash.

Any other vendor degrades: the body is documented as a permissive schema, the
operation is tagged `x-schema-vendor: "valibot"`, query parameters it cannot name
are omitted, and a warning says so. Nothing throws, and nothing claims to have
read a schema it could not.

```ts
const { document, warnings } = await generateDocument(routes, info);
// warnings: ['ForeignController_create Body: no JSON Schema conversion for ...']
```

`app.get(OpenApiExplorer).warnings` is the same list, readable straight after
`create()` — the document is generated at boot, so a degradation is visible before
the first request rather than after it.

### `$defs` becomes `components/schemas`

`.meta({ id })` on a zod schema names the definition zod emits, and that slot is
what OpenAPI calls `components/schemas`. The mapping is a prefix rewrite:

```ts
const Tag = z.object({ label: z.string() }).meta({ id: 'Tag' });
const CreateUser = z
  .object({ name: z.string(), tags: z.array(Tag) })
  .meta({ id: 'CreateUser' });

z.toJSONSchema(CreateUser);
// { type: 'object', properties: { tags: { items: { $ref: '#/$defs/Tag' } } },
//   $defs: { Tag: { ... } } }
```

Every `$defs` entry is hoisted into `components/schemas` and every
`#/$defs/Tag` is rewritten to `#/components/schemas/Tag`. The definitions
themselves need no editing at all. Three details are not just the prefix:

- **The root is not in `$defs`.** zod inlines the schema you passed and only
  extracts what it *references*. A body schema with an `id` is therefore hoisted
  here, under that id, and referenced — so `requestBody` is a `$ref` and the
  component is reusable.
- **A cyclic schema refs the document root as `$ref: '#'`.** That means "this
  schema", which stops being true the moment it is one entry among many, so a
  self-referential schema is always hoisted and its `#` is repointed at its own
  component. Left alone it would resolve to the OpenAPI document itself.
- **Two schemas with one `id`** keep the first and warn. Renaming would silently
  repoint a ref a caller had already read.

`io: 'input'` is used, not the default `'output'`: a field with a `.default()` is
optional in a request and present in a handler, and `additionalProperties: false`
is an output-side claim. `unrepresentable: 'any'` because a `Date` in one schema
must not take the whole document down — zod throws otherwise.

### Validate the output

A dangling `$ref` is the usual way generated OpenAPI is quietly broken: viewers
render an empty box and report nothing.

```ts
import { danglingRefs } from '@dunx/openapi';

expect(danglingRefs(document)).toEqual([]);
```

Every `$ref` in the document that does not land on a present
`components/schemas` entry, including a stray `#`. The generator runs it on itself
and turns a hit into a warning.

## What each operation gets

| From                              | Becomes                                     |
| --------------------------------- | ------------------------------------------- |
| Controller + handler name         | `operationId`, e.g. `UsersController_list`   |
| Controller name                   | `tags: ['Users']`                            |
| `:id` in the path                 | `/users/{id}` plus a path parameter          |
| `options.params`                  | The path parameters' real schemas            |
| `options.query`                   | One query parameter per property             |
| `options.body`                    | `requestBody`, `application/json`            |
| `options.status`, else 201 or 200 | The success response                         |
| Any declared schema               | A `400` referencing `ValidationError`        |
| `@Public()` / `@Roles()`          | `security` — see below                       |
| `@ApiDoc()`                       | `summary`, `description`, `tags`, deprecation |

Path parameters are driven by the path, not by the schema: OpenAPI requires every
path parameter to appear in the template, so a `params` property that is not a
token in the path is not one. A token with no schema is documented as a string —
which is what it is on the wire.

The `400` is real and worth documenting. It is `defaultErrorMapper`'s output for a
`ValidationError`, with the issue paths flattened by `buildInputReader`:

```json
{ "error": "Invalid body", "status": 400, "issues": [{ "message": "…", "path": "tags.0.label" }] }
```

There is no response *body* schema, because `RouteSchemas` has no `response` field
to read one from. Inventing a second channel for it would be the drift this
package exists to avoid.

### Security comes from the guards' own metadata

`@Public()` and `@Roles()` are `MetaKey`s that guards read at runtime. The
generator reads the same records off the same route:

| Route metadata      | Operation                                              |
| ------------------- | ------------------------------------------------------ |
| `@Public()`         | `security: []` — explicitly open, overrides a default  |
| `@Roles('editor')`  | `security: [{ bearer: [] }]`, `x-required-roles`, prose |
| Neither             | No `security` key; inherits the document default        |

The `bearer` scheme is only declared in `components/securitySchemes` when some
route asked for it. Roles are not scopes, so they are surfaced as
`x-required-roles` and as a line in the description rather than being smuggled
into a scheme's scope list.

Two things this deliberately does not infer. Class-level `@Roles` is merged into
every route of the class — so it is documented on all of them, whether or not a
`RolesGuard` is wired in front of each. And a guard installed as global
middleware is invisible to a route, so "has a guard" is not a thing the document
can claim. Metadata is the channel; wiring is not.

### `@ApiDoc`

Prose no schema can carry, on the same mechanism as `@Roles`:

```ts
import { ApiDoc } from '@dunx/openapi';

@ApiDoc({
  summary: 'One user',
  description: 'Reads a single user by id.\n\nReturns `404` when there is none.',
  tags: ['People'],
  deprecated: false,
})
@Get('/:id', oneUser)
one(input: Input<typeof oneUser>) {}
```

## The page

`GET /docs` is one self-contained HTML document: a `<style>` block, `<details>`
for the folding, one inline `<script>`, and **nothing to fetch** — no CDN, no
`src=`, no bundled copy of somebody else's viewer. It renders operations grouped
by tag with their parameters, request bodies, responses and security, then the
schemas.

Two Bun APIs do the work a dependency usually would: `Bun.escapeHTML` escapes
every interpolation, and `Bun.markdown.html` renders descriptions — with
`noHtmlBlocks`, `noHtmlSpans` and `tagFilter` on, so raw HTML in a schema's
description is escaped rather than trusted.

### Sending a route

Every operation gets a form, so a route can be executed from the page — the one
thing a static rendering cannot do, and the usual reason to reach for swagger-ui.

- **Path parameters** are substituted into the template. Every `{name}` gets an
  input whether or not the document declares it, so a request can never go out
  with a literal `{id}` in it.
- **Query parameters** are appended only when filled in.
- **The body** arrives pre-filled from the schema — refs resolved, `minimum` and
  `format` honoured — so sending is a click rather than a typing exercise.
- **Headers** are one `Name: value` per line, which is why there is no special
  `Authorization` field. Operations that declare a security scheme start with
  `Authorization: Bearer ` already in the box.
- The response shows the status, the elapsed time, the headers and the body,
  pretty-printed when it is JSON.

That is ~90 lines of inlined JavaScript. `swagger-ui-dist` unpacks to 11.7 MB and
`@scalar/api-reference` to 11 MB to do the same job; neither is a dependency this
package is willing to take, and both would end the no-external-requests guarantee
that `html.test.ts` asserts.

If you want one of them anyway, point it at `/openapi.json`. Serving your own page
is one route:

```ts
import { renderPage } from '@dunx/openapi';
```

## Without the module

The generator needs no container and no server. `describeRoutes` reads a module
graph's routes without constructing a controller — `discoverRoutes` walks a
prototype chain, and `Object.create(Controller.prototype)` is that chain with
nothing behind it — so a document can be written to a file from a script:

```ts
import { describeRoutes, generateDocument } from '@dunx/openapi';

const { document } = await generateDocument(describeRoutes(AppModule), {
  title: 'Payments',
  version: '1.4.0',
});
await Bun.write('openapi.json', JSON.stringify(document, null, 2));
```

Given an array of `DiscoveredRoute`s from anywhere else, `generateDocument` takes
that too — it is the same type `@dunx/http` hands its own router.

## The global prefix

`setGlobalPrefix('api')` is applied to the route table when the server binds,
after the container is built, and is not readable from inside it. So the
document's own route derives it from its own URL: declared at `/openapi.json`,
answered at `/api/openapi.json`, therefore every other path moved by the same
`/api`. Documents are cached per prefix.

That inference is the one piece of guesswork in this package. An `HttpApp.routes`
accessor exposing the discovered, prefixed table would remove it, and would also
remove the need to name the root module twice over.

## Verified against

zod 4.4.3 and Bun 1.3.14. `z.toJSONSchema` inlining a registered root, emitting
`$ref: '#'` for a cycle, throwing on `z.date()` without `unrepresentable`, and
dropping `additionalProperties` under `io: 'input'` were all measured rather than
assumed, and each is pinned by a test.
