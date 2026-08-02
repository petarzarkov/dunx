# @dunx/openapi

An OpenAPI 3.1 document generated from the routes an app already has, and a docs
page served from the same `Bun.serve` as everything else. Zero dependencies beyond
`@dunx/core` and `@dunx/http`; no `swagger-ui-dist`, no `@scalar/*`, no template
engine, no HTTP client.

The difference from a reflection-based generator is what it reads. A route's
schemas are objects the request path validates against, and its metadata is what
its guards enforce. Both are already on the route, so the document is not a second
description that can drift from the first - it is the first one, rendered.

```ts
import { HttpFactory } from '@dunx/http';
import { OpenApiModule } from '@dunx/openapi';

const app = await HttpFactory.create(
  OpenApiModule.forRoot({
    title: 'Payments',
    version: '1.4.0',
    root: AppModule, // the graph to document - and the graph that gets imported
  }),
);
app.setGlobalPrefix('api');
await app.listen(3000);
// GET /api/openapi.json   the document
// GET /api/docs           the page
```

`forRoot` returns a `DynamicModule` that imports the root it documents, so
`HttpFactory.create()` is still handed exactly one module ref. What it adds is one
controller with two `@Public()` `GET` routes - mounted, discovered, guarded,
middleware-wrapped and CORS-wrapped like any other. Nothing is bolted onto the
server behind the app's back, which is also why the docs routes appear in the
document: they are routes.

| Option        | Default          | Effect                                    |
| ------------- | ---------------- | ----------------------------------------- |
| `title`       | -                | `info.title`                              |
| `version`     | -                | `info.version`                            |
| `description` | -                | `info.description`, rendered as markdown  |
| `servers`     | -                | `servers`, verbatim                       |
| `root`        | -                | The module graph to document              |
| `path`        | `/docs`          | Where the HTML page is mounted            |
| `jsonPath`    | `/openapi.json`  | Where the document is mounted             |

`forRootAsync({ root, useFactory, inject })` is the same module with everything but
`root` produced by a factory that may await and may inject, for the usual reason
every other configurable module has the pair: reading the title, the version or the
mount path off `ConfigService` is the one thing a plain `forRoot` cannot do.

## zod is a peerDependency, and that is the point

Bun ships no schema API, so validation is the one place dunx cannot satisfy its
own native-only rule. The resolution is that the framework's contract is
**Standard Schema** - an interface, restated at zero dependency cost - and the one
place a vendor-specific API is genuinely needed is here:

```ts
if (schema['~standard'].vendor === 'zod') // z.toJSONSchema
```

Standard Schema v1 has no JSON Schema export. It validates; it does not describe.
So conversion is per vendor, behind that check, and zod is the vendor implemented.
It is imported **dynamically**, on first sight of a zod schema - an app on Valibot
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
`create()` - the document is generated at boot, so a degradation is visible before
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
  here, under that id, and referenced - so `requestBody` is a `$ref` and the
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
must not take the whole document down - zod throws otherwise.

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
| `options.response`               | A `content` schema per status code           |
| Any declared schema               | A `400` referencing `ValidationError`        |
| `@Public()` / `@Roles()`          | `security` - see below                       |
| `@ApiDoc()`                       | `summary`, `description`, `tags`, deprecation |

Path parameters are driven by the path, not by the schema: OpenAPI requires every
path parameter to appear in the template, so a `params` property that is not a
token in the path is not one. A token with no schema is documented as a string -
which is what it is on the wire.

The `400` is real and worth documenting. It is `defaultErrorMapper`'s output for a
`ValidationError`, with the issue paths flattened by `buildInputReader`:

```json
{ "error": "Invalid body", "status": 400, "issues": [{ "message": "…", "path": "tags.0.label" }] }
```

### Response bodies

`options.response` is the same channel as the request side, keyed by status code:

```ts
const one = {
  params: UserIndex,
  response: { 200: SanitizedUser, 404: Problem },
} as const satisfies RouteSchemas;
```

A named schema hoists into `components/schemas` and the response `$ref`s it,
exactly as a request body does, so the document can drive client codegen. Two
things follow from it being one contract rather than a second channel:

- It is converted with `io: 'output'`, because it describes what comes **back**: a
  field with a default is always present, and `additionalProperties: false` is an
  output-side claim. A schema used in both directions therefore converts twice, and
  if the two views differ it needs a different `.meta({ id })` for each.
- **It is never validated.** It documents the response; it does not enforce it.
  Paying a validation pass on every response for a documentation feature would be
  the wrong trade, and the handler's return type already checks the answer at
  compile time. Nothing in `@dunx/http`'s request path reads the key.

### Security comes from the guards' own metadata

`@Public()` and `@Roles()` are `MetaKey`s that guards read at runtime. The
generator reads the same records off the same route:

| Route metadata      | Operation                                              |
| ------------------- | ------------------------------------------------------ |
| `@Public()`         | `security: []` - explicitly open, overrides a default  |
| `@Roles('editor')`  | `security: [{ bearer: [] }]`, `x-required-roles`, prose |
| Neither             | No `security` key; inherits the document default        |

The `bearer` scheme is only declared in `components/securitySchemes` when some
route asked for it. Roles are not scopes, so they are surfaced as
`x-required-roles` and as a line in the description rather than being smuggled
into a scheme's scope list.

Two things this deliberately does not infer. Class-level `@Roles` is merged into
every route of the class - so it is documented on all of them, whether or not a
`RolesGuard` is wired in front of each. And a guard installed as global
middleware is invisible to a route, so "has a guard" is not a thing the document
can claim. Metadata is the channel; wiring is not.

### `@ApiDoc`

Prose no schema can carry, on the same mechanism as `@Roles`:

```ts
import { ApiDoc } from '@dunx/openapi';

@ApiDoc({ tags: ['People'] })
@Controller('users')
class UsersController {
  @ApiDoc({
    summary: 'One user',
    description: 'Reads a single user by id.\n\nReturns `404` when there is none.',
  })
  @Get('/:id', oneUser)
  one(input: Input<typeof oneUser>) {}
}
```

The class's and the method's compose **per field**, the method winning where both
spoke, so class tags plus per-method summaries needs no repetition. The document's
top-level `tags` list is then derived from the tags the operations actually carry,
which is what keeps a viewer's sidebar and its operation list in agreement.

## The page

`GET /docs` is one self-contained HTML document: a boot `<style>`, the document
as JSON, the API explorer inlined as a second `<script>`, and **nothing to
fetch** - no CDN, no `src=`, no `<link>`. It is an API explorer, with a
disclosure control per operation, an **Authorize** dialog, parameter and schema
tables, colour-coded status codes, a filter box and a light/dark toggle.

The explorer is a real frontend - Vite, React and Mantine, in `tools/openapi-ui` whose **built bundle** is what this package serves. Nothing about it is
hand-written markup in a backend package any more, and nothing about it is
fetched: `bun run build` writes the tree-shaken bundle into `src/ui-bundle.ts`,
and `renderPage` inlines that string. 437 KiB, against `swagger-ui-dist`'s
11.7 MB unpacked and `@scalar/api-reference`'s 11 MB - neither of which is a
dependency this package is willing to take, and both of which would end the
no-external-requests guarantee that `html.test.ts` asserts.

**That bundle is behind `@dunx/openapi/ui`, and it is loaded on demand.** The
barrel does not import it, and `OpenApiExplorer.page()` reaches it through a
dynamic import on the first request for the page, so a service that never opens
`/docs` never parses a React app. Importing `@dunx/openapi` costs 19,807 B and
about 5.7 ms rather than 479,596 B and about 10.9 ms.

The document itself travels in a `<script type="application/json">`, so the page
boots without a request. Two Bun APIs do the work a dependency usually would:
`Bun.escapeHTML` escapes the shell, and `Bun.markdown.html` renders every
description **on the server** - with `noHtmlBlocks`, `noHtmlSpans` and
`tagFilter` on, so raw HTML in a schema's description is escaped rather than
trusted, and no markdown parser lands in the bundle. `sampleFor` runs there too,
for the same reason.

### Sending a route

Every operation is executable from the page - the one thing a static rendering
cannot do, and the usual reason to reach for swagger-ui.

- **Credentials are entered once.** The **Authorize** dialog reads
  `components.securitySchemes` and offers a field per scheme: a bearer token, an
  API key (sent as the header or query parameter the scheme names), or a basic
  username and password. They are applied to every operation that declares the
  scheme and kept in the tab's `sessionStorage`.
- **Path parameters** are substituted into the template. Every `{name}` gets an
  input whether or not the document declares it, so a request can never go out
  with a literal `{id}` in it.
- **Query parameters** are appended only when filled in.
- **The body** arrives pre-filled from the schema - refs resolved, `minimum` and
  `format` honoured - so sending is a click rather than a typing exercise.
- **Extra headers** are still one `Name: value` per line, and a line typed by
  hand wins over what the dialog would have sent.
- The response shows the status, the elapsed time, the size, the headers and the
  body, pretty-printed when it is JSON.

The page needs JavaScript, which the hand-written one did not. That is the cost
of the explorer; `<noscript>` links the document itself.

If you would rather point swagger-ui or Scalar at `/openapi.json`, serving your
own page is one route. `buildModel` is exported too, so a page of your own can
reuse the pre-rendered prose, the samples and the fields:

```ts
import { buildModel, renderShell } from '@dunx/openapi';
// The same shell with dunx's own explorer in it. This is the import that costs
// 456 KB, which is why it is a subpath rather than part of the barrel.
import { renderPage } from '@dunx/openapi/ui';
```

`renderShell(document, options, ui)` takes the script to inline as its third
argument, so a page built on your own frontend never loads dunx's.

## Without the module

The generator needs no container and no server. `describeRoutes` reads a module
graph's routes without constructing a controller - `discoverRoutes` walks a
prototype chain, and `Object.create(Controller.prototype)` is that chain with
nothing behind it - so a document can be written to a file with no database and no
port.

That is a `bin`, because every app was otherwise writing the same forty lines:

```bash
bunx dunx-openapi ./src/app.module.ts
bunx dunx-openapi ./src/openapi.config.ts --out public/openapi.json
bunx dunx-openapi ./src/app.module.ts --stdout | jq '.paths | keys'
```

The entry exports either the root module as `default` or `root`, in which case
title and version come from the nearest `package.json`, or an `openapi` function
for anything more:

```ts
export const openapi = () => ({
  root: appModule({ source, logLevel: 'fatal' }),
  title: pkg.name,
  version: pkg.version,
  // Better Auth serves its own endpoints, so route discovery cannot see them.
  contribute: [betterAuthDocument(auth, { basePath: '/api/auth' })],
});
```

**`contribute` is why the CLI takes a function rather than only a module path.** A
contribution describes endpoints dunx does not route, so it is the app's to
declare - no CLI can infer that an app mounted Better Auth, or with which options.

The primitives stay public for anything the CLI does not cover:

```ts
import { describeRoutes, generateDocument } from '@dunx/openapi';

const { document } = await generateDocument(describeRoutes(AppModule), {
  title: 'Payments',
  version: '1.4.0',
});
await Bun.write('openapi.json', JSON.stringify(document, null, 2));
```

Given an array of `DiscoveredRoute`s from anywhere else, `generateDocument` takes
that too - it is the same type `@dunx/http` hands its own router.

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
