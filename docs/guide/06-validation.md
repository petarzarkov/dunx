# Validation

A route declares the shape of what it accepts on the decorator itself, and the
framework parses, validates and types the request before the handler runs.

```ts
import {
  Controller,
  Get,
  Post,
  type Input,
  type RouteSchemas,
} from '@dunx/http';
import { z } from 'zod';

const CreateUser = z.object({ name: z.string().min(1).max(40) });
const createUser = { body: CreateUser } as const satisfies RouteSchemas;

@Controller('users')
export class UsersController {
  constructor(private readonly users: UsersService) {}

  @Post('/', createUser)
  create(input: Input<typeof createUser>): Promise<User> {
    return this.users.create(input.body.name);
  }
}
```

No `await req.json()`, no `Response.json()`, no status: the body arrives parsed
and validated, `input.body.name` is a `string`, and a POST answers 201. A request
that fails the schema never reaches the handler.

## Standard Schema is the contract, not zod

`@dunx/http` has **no validator dependency**. Its `peerDependencies` are
`@dunx/core` and (optionally) `@types/bun`, and that is the whole list. What a
route's `body`, `query` and `params` accept is anything implementing
[Standard Schema v1](https://standardschema.dev): an object carrying a
`~standard` property.

```ts
export interface StandardSchemaV1<In = unknown, Out = In> {
  readonly '~standard': {
    readonly version: 1;
    readonly vendor: string;
    readonly validate: (
      value: unknown,
    ) => StandardSchemaResult<Out> | Promise<StandardSchemaResult<Out>>;
    readonly types?: { readonly input: In; readonly output: Out } | undefined;
  };
}
```

That interface is **restated** in `packages/http/src/route/schema.ts` rather than
imported. The spec is an interface and nothing else: `@standard-schema/spec` ships
declarations with no runtime, so restating it costs one file and keeps the package
at zero dependencies. zod 4, Valibot and ArkType already satisfy the shape, so all
three drop straight into a route's options with nothing adapting anything:

```ts
import { z } from 'zod';
import * as v from 'valibot';
import { type } from 'arktype';

const withZod = { query: z.object({ limit: z.coerce.number() }) } as const;
const withValibot = { query: v.object({ limit: v.number() }) } as const;
const withArkType = { query: type({ limit: 'number' }) } as const;
```

The one thing the framework reads is `schema['~standard'].validate(value)`. It
does not know or care which library produced the object.

### Sync and async validators

`~standard.validate` is _permitted_ to return a promise. zod, Valibot and ArkType
never do, and the input reader is built around that: it checks
`result instanceof Promise` and only allocates a promise link when it gets one.
A validator that really is asynchronous still works and is awaited correctly; it
just costs an async frame that the synchronous ones do not.

## `RouteSchemas`

The second argument to `@Get` / `@Post` / `@Put` / `@Patch` / `@Delete`:

```ts
export interface RouteSchemas {
  readonly body?: StandardSchemaV1;
  readonly query?: StandardSchemaV1;
  readonly params?: StandardSchemaV1;
  /** Overrides the default success status: 201 for POST, 200 otherwise. */
  readonly status?: number;
  /** What the route answers with, keyed by status. Documented, never validated. */
  readonly response?: Readonly<Record<number, StandardSchemaV1>>;
}
```

**Declaring a schema is what makes the matching field appear.** Omit `query` and
the framework never parses a query string; omit `body` and it never reads the
request stream. There is no "validate everything by default" mode and no global
pipe to turn off, because there is nothing to turn off: an undeclared source is
untouched code, not skipped code.

`response` is the exception that proves the rule, and the one key here the request
path never reads:

```ts
export const oneUser = {
  params: UserIndex,
  response: { 200: SanitizedUser, 404: NotFound },
} as const satisfies RouteSchemas;
```

It is the same Standard Schema contract as the request side, so
[`@dunx/openapi`](./09-openapi.md) hoists a named response schema into
`components/schemas` exactly as it hoists a body. But it **documents the response;
it does not enforce it.** Running a validation pass over every response body would
be a per-request cost paid for a documentation feature, and the handler's own
return type already checks the answer at compile time and for free. `response`
does not appear in `Input<O>` either: nothing about it reaches the handler.

Write the options object next to the schemas and hand the same value to both the
decorator and the annotation:

```ts
import type { RouteSchemas } from '@dunx/http';
import { z } from 'zod';

export const UserIndex = z.object({ id: z.coerce.number().int().min(1) });
export const ListUsers = z.object({
  q: z.string().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(50).default(10),
});

export const oneUser = { params: UserIndex } as const satisfies RouteSchemas;
export const listUsers = { query: ListUsers } as const satisfies RouteSchemas;
```

`as const` is load bearing. Without it `{ body: CreateNote, status: 201 }` widens
to `RouteSchemas` and `Input<typeof opts>` degrades to a bare `{ req }`, taking
the type check with it. `satisfies RouteSchemas` checks the object without
widening it, which is why the pair is written that way rather than with a type
annotation.

### Path params

Bun's router matches `/users/:id` and puts the segment on `req.params`. Declaring
a `params` schema validates that object and replaces it with the schema's output:

```ts
@Get('/:id', oneUser)
async one(input: Input<typeof oneUser>): Promise<User> {
  const user = await this.users.find(input.params.id);
  ...
}
```

Without a `params` schema the raw values are still reachable at
`input.req.params`. The framework does not hide them; it just does not type or
check them.

### Query strings

Query values are read with `URLSearchParams` and grouped before validation, so a
repeated key becomes an array:

```
?tag=a&tag=b   ->   { tag: ['a', 'b'] }
?tag=a         ->   { tag: 'a' }
```

That is deliberate: dropping `a` silently is the behaviour a schema can never
recover from. If a field is single-valued, say so in the schema and a repeated key
becomes a 400 rather than a surprise.

The query string is sliced out of `req.url` by hand rather than through
`new URL(req.url)`. Constructing a `URL` resolves scheme, host, port, path and
fragment to hand back one `searchParams` object, and it measured at about
1,040 ns of the roughly 1,520 ns a three-pair query route cost, which is more than
the entire body reader. The fragment is still stripped, even though a client is not
supposed to send one, so a hostile request target cannot change what a schema sees.

### Bodies

The content type decides the parser:

| `content-type`                       | parsed with                         |
| ------------------------------------ | ----------------------------------- |
| `application/json`, anything `+json` | `req.json()`                        |
| `application/x-www-form-urlencoded`  | `URLSearchParams`, grouped          |
| `multipart/form-data`                | `req.formData()`, grouped           |
| `text/*`                             | `req.text()`                        |
| anything else                        | 415, before the schema is consulted |

No `content-type` header at all reads as JSON. `fetch` omits the header for a
bodyless request, and answering 415 there would be useless because the schema is
about to reject `undefined` with a better message anyway.

## Coercion

Path params and query values arrive as **strings**, always. HTTP has no other
representation for them. Coercion is the schema's job, not the framework's, and
with zod it is one call:

```ts
export const UserIndex = z.object({ id: z.coerce.number().int().min(1) });
```

`z.coerce.number()` turns `"42"` into `42` before `.int().min(1)` runs, so by the
time the handler executes `input.params.id` is a `number` at runtime **and** in
the type, because `Input<>` reads the schema's _output_ type rather than its
input:

```ts
@Get('/:id', oneUser)
async one(input: Input<typeof oneUser>): Promise<User> {
  // Already a number. The params schema coerced it before this ran.
  const user = await this.users.find(input.params.id);
  if (user === null) {
    throw new HttpError(HttpStatusCode.NOT_FOUND, `No user ${input.params.id}`);
  }
  return user;
}
```

The same applies to query defaults. `limit: z.coerce.number().int().min(1).max(50).default(10)`
means the handler sees a `number` whether or not the caller sent `?limit=`, and
`"999"` is a 400 rather than a page size nobody intended.

This is one of the two reasons the framework does not try to be clever about
types on its own. The other is that `.default()` changes the _type_ as well as the
value, and only the validator knows that.

## `Input<typeof schema>` and why it must be written out

The annotation on the handler parameter is not optional, and it is not a wart the
framework can remove.

A TC39 standard method decorator is
`(value: V, context: ClassMethodDecoratorContext) => V | void`. It receives the
method and can _reject_ one whose type does not match, but there is no mechanism
in the proposal for a decorator to contextually type an unannotated parameter.
This was measured with `tsc` rather than assumed:

```
annotated correctly            -> compiles
unannotated parameter          -> TS7006: Parameter 'input' implicitly has an 'any' type
annotated with the wrong type  -> TS1241 + TS1270, naming the mismatched property
```

So the guarantee is a _check_, not an inference. Get the annotation wrong and the
compiler names the property that does not line up; leave it off and `strict` mode
rejects the implicit `any`. What it is never allowed to be is silently wrong.

The saving grace is that **no type is written twice**. `Input<O>` is a type-level
function over the options object:

```ts
export type Input<O extends RouteSchemas> = {
  readonly req: BunRequest;
} & (O extends { body: infer B }
  ? { readonly body: InferOutput<B> }
  : unknown) &
  (O extends { query: infer Q }
    ? { readonly query: InferOutput<Q> }
    : unknown) &
  (O extends { params: infer P }
    ? { readonly params: InferOutput<P> }
    : unknown);
```

Every field type still comes from the schema. `Input<typeof createUser>` is
`{ req: BunRequest; body: { name: string } }` because `CreateUser` says so, and
changing the schema changes the handler's type with no second edit.

A route with no schemas at all still gets the request:

```ts
@Get('/whoami')
whoami(input: Input<RouteSchemas>): { ip: string | undefined } {
  return { ip: this.address.of(input.req) };
}
```

`InferOutput<S>` is exported separately for the times a service signature needs
the same type: `InferOutput<typeof CreateUser>` is `{ name: string }`.

Related reading: [Controllers](./05-controllers.md) covers the decorators
themselves and how a return value becomes a `Response`.

## What a validation failure produces

A rejected schema throws `ValidationError`, which is an `HttpError` with status
400 carrying every issue the validator reported. The default error mapper turns it
into:

```json
{
  "error": "Invalid body",
  "status": 400,
  "issues": [{ "message": "<the validator's own message>", "path": "name" }]
}
```

The message is whatever the validator produced, passed through unaltered: dunx
does not rewrite, translate or truncate it, because the library that rejected the
value is the one that knows why.

Three things worth knowing about that shape:

- **`error` names the source.** `Invalid body`, `Invalid query` or
  `Invalid params`, so a caller can tell a bad payload from a bad page size.
- **The issues survive into the response.** A caller cannot fix what it cannot
  see. This is the one place the framework deliberately echoes detail about the
  request back to the caller, on the reasoning that a 400 is by definition the
  caller's own input.
- **`path` is flattened to dots**, and absent when the root itself failed.
  Standard Schema lets a vendor report a path as bare keys (zod) or as
  `{ key }` objects (Valibot); both are normalised here to a single string.

Two other failures are not validation failures and do not carry issues:

- A body the caller mangled is `400 Malformed application/json body`. The parse
  rejected, so there was never a value to validate.
- An undeclared content type is
  `415 Unsupported content type "application/xml". Declared bodies accept
application/json, application/x-www-form-urlencoded, multipart/form-data or text/*.`

Replace all of it by passing `onError` to `HttpFactory.create`; see
[Middleware and guards](./07-middleware-and-guards.md#the-error-mapper).

## Vendor-specific features sit behind a vendor check

Standard Schema **validates**. It deliberately says nothing about describing,
serialising or converting a schema, so there is no vendor-neutral way to turn one
into JSON Schema. `@dunx/openapi` needs exactly that, and resolves it with the one
piece of vendor information the interface does carry:

```ts
export const vendorOf = (schema: StandardSchemaV1): string =>
  schema['~standard'].vendor;
```

If the vendor is `zod`, the package dynamically imports zod and calls
`z.toJSONSchema(schema, { io: 'input', unrepresentable: 'any' })`. If it is
anything else, the schema is documented as permissive and a warning is recorded:

```
UsersController_createBody: no JSON Schema conversion for Standard Schema vendor
"valibot". Standard Schema validates; it does not describe. The schema is
documented as permissive.
```

Warnings are readable off `app.get(OpenApiExplorer).warnings` straight after
`HttpFactory.create()`, so a degraded document is visible at boot rather than at
the moment somebody notices an empty request body in the explorer. zod is an
**optional** `peerDependency` of `@dunx/openapi`: a consumer on Valibot never
loads it, and a consumer without it installed gets warnings rather than a
module-resolution crash. Details in [OpenAPI](./09-openapi.md).

The rule generalises: validation stays library-agnostic because a standard exists;
anything the standard does not cover is gated on `~standard.vendor` and degrades
loudly.

## What validation costs

This repo publishes its losses, and here the loss is not where most people expect.

Four raw `Bun.serve` routes, each doing exactly one thing more than the one above
it, all answering the same bytes, all against a 69 byte three-field payload:

| Step                                 |   req/s | µs/req | this step adds |
| ------------------------------------ | ------: | -----: | -------------: |
| `GET /json`, no request body at all  | 113,881 |   8.78 |              - |
| `POST`, body on the wire, never read | 110,537 |   9.05 |       +0.27 µs |
| `POST` + `await req.json()`          |  82,341 |  12.14 |       +3.10 µs |
| `POST` + `req.json()` + zod          |  76,412 |  13.09 |       +0.94 µs |

**Reading the body costs about three times what validating it costs.** Putting the
payload on the wire is near free; `req.json()` is 3.10 µs and zod is 0.94 µs. Of
the roughly 30% throughput drop between a JSON route and a validating one, 77% is
`req.json()` and 23% is the validator. No framework can remove the parse, and no
choice of validator affects it.

Which is why there is no throughput argument for steering anyone off zod:

| Validator                   |    costs | `~standard` |
| --------------------------- | -------: | ----------- |
| TypeBox, `TypeCompiler` AOT | -0.01 µs | bridged     |
| ajv, compiled JSON Schema   |  0.34 µs | bridged     |
| ArkType                     |  0.42 µs | native      |
| Valibot                     |  0.89 µs | native      |
| zod                         |  0.94 µs | native      |

zod, Valibot and ArkType are within noise of each other; the noise floor for that
harness is about ±0.3 µs. Both compiled options land at or under it, which means
TypeBox's compiled checker is indistinguishable from not validating at all on a
payload this size. Saving 0.9 µs on a 13 µs request is 7%, against giving up zod's
ecosystem, error messages and `z.toJSONSchema`. Pick on API and error quality.

The number that _was_ worth chasing was the framework's own. A route with a
declared `body` used to go through six `async` frames, exactly one of which
(`req.json()`) ever had anything to wait for, and the reader's plumbing cost
2.05 µs, nearly twice what zod itself cost. Rebuilding it to adopt promises rather
than await them took the plumbing from 597 ns to 146 ns with a no-op schema, and a
`params`-only route with a synchronous validator now reads and validates in 56 ns
with no promise allocated at all. In the benchmark suite that moved the `validate`
scenario from 84.0% of raw `Bun.serve` to over 92%, and put dunx ahead of Elysia
on the one scenario where it used to be level.

The full harness, its caveats and how to rerun it are in `internal/bench/README.md`.

## Sharp edges

- **`as const` is not optional.** Drop it and the handler's `input` silently
  becomes `{ req }`. `satisfies RouteSchemas` is what catches a typo in a key
  name without re-widening the object.
- **A `params` schema replaces `req.params` on `input`, not on `req`.**
  `input.req.params` is still the raw string record.
- **The framework validates input, not output.** A handler's return value is
  serialised as it is, `response` schemas included: they document the answer for
  `@dunx/openapi` and nothing checks them at runtime. If a response shape matters,
  the annotation on the handler is what enforces it.
- **`status` on the options object changes the success status only.** Errors
  still come from the thrown `HttpError` or from the mapper.
- **A schema that is not an object is fine for `body` and wrong for
  `query`/`params`.** A query string is a set of named parameters, so a non-object
  schema there documents nothing and `@dunx/openapi` warns about it.
- **Request-body logging is off by default** and reading it means
  `req.clone().text()`, a second buffered copy of every payload. Turning both body
  options on costs roughly two thirds of the throughput on the `validate`
  scenario, and the request body is the field most likely to contain a password.
  See [Middleware and guards](./07-middleware-and-guards.md#request-logging).
