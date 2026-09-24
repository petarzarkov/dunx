# Publishing a package

A dunx package is a module other applications import. `@dunx/infra` and
`@dunx/auth` are shaped that way, and nothing about them is privileged: a module
declared in your package and exported from its entrypoint works in someone
else's app the same way.

Two things differ from publishing an ordinary TypeScript library. Both of them
fail in the consumer's application rather than in your build, so neither is
visible from where you are standing.

## Record constructor dependencies at build time

`@dunx/transform` reads constructor parameter types and records them on the
class. At runtime it registers as a Bun plugin through a preload, and that
plugin skips `node_modules`. A package whose classes carry no records ships
classes the container cannot construct, and the app author has no way to fix it
from their side.

The records therefore have to be in the published JavaScript.
`@dunx/transform/build` puts them there and does the rest of a package build:

```ts
// build.ts
import { buildPackage } from '@dunx/transform/build';

const built = await buildPackage();
console.log(`${built.name}: ${built.entries} entries, ${built.ms}ms`);
```

```json
{
  "type": "module",
  "exports": {
    ".": { "types": "./dist/index.d.ts", "import": "./dist/index.js" }
  },
  "files": ["dist"],
  "scripts": { "build": "bun build.ts" },
  "devDependencies": {
    "@dunx/transform": "<latest>",
    "typescript": "7.0.2"
  }
}
```

`<latest>` stands for the current release, pinned exactly. `@dunx/transform/build`
first shipped in 3.9.3, so nothing older works here.

Entrypoints are read from `exports` and `bin`, so a subpath you declare is a
subpath you build. Declarations come from `tsc --emitDeclarationOnly`, because
Bun emits none, and `typescript` is a `devDependency` for that reason.
`buildPackage({ declarations: false })` skips the step and the dependency.

The layout is assumed rather than configurable: sources under `src/`, output to
`dist/`, one `tsconfig.json` at the package root.

Three ways of building look like they would work and do not.
`bun build --outdir dist` takes no plugin from the command line. `tsc` alone
knows nothing about the transform. Shipping your `.ts` sources leaves the
consumer's plugin skipping them along with the rest of `node_modules`.

Read the output rather than trusting the intent:

```sh
grep -c 'dunx.deps' dist/index.js
```

## Peer-depend on `@dunx/core`

```json
{
  "peerDependencies": { "@dunx/core": "^3.9.0" },
  "devDependencies": { "@dunx/core": "<latest>" }
}
```

A token in this container is a class object. Two copies of `@dunx/core` in one
dependency tree export two different `Logger` classes, and a binding registered
against one is invisible to the other. Listing core under `dependencies` is what
produces the second copy. A peer resolves to the application's.

`AppFactory.create` counts the copies and refuses to boot on more than one, so
the symptom is a boot error naming the cause. Copies published before that check
existed do not register themselves and stay silent.

The caret spans the major version. Every `@dunx/*` package shares one version
and is released together, so `^3.9.0` means 3.9.0 or later within 3.x, and a
breaking change to a published entrypoint waits for 4.0.0. The reasoning behind
lockstep is in [packaging](../architecture/packaging.md).

## Where to plug in

Most packages export a module and stop there. For the rest, these are the
contracts already meant for an implementation that lives outside this
repository:

| Contract          | From                | You supply                    |
| ----------------- | ------------------- | ----------------------------- |
| `EmailTransport`  | `@dunx/infra/email` | a delivery backend            |
| `CacheStore`      | `@dunx/infra/cache` | a cache backend               |
| `HealthIndicator` | `@dunx/http`        | a readiness or liveness probe |
| `ThrottleStore`   | `@dunx/http`        | a rate-limit counter          |
| `DocsRenderer`    | `@dunx/openapi`     | an API explorer page          |

Every one of them is an abstract class rather than an interface, because a
constructor parameter has to name something that exists at runtime for the
transform to record it. Subclass it, bind it in your module, and the application
injects the contract.

`Middleware` is the exception in both respects. It is an interface, and the
class implementing it is what gets registered: a guard throws, an interceptor
wraps `next()`, a filter maps the error. A module's `middleware` array reaches
that module's own controllers, and anything wider needs the application to call
`app.use(YourMiddleware)`, so a package shipping one has to say so in its
README.

Handler discovery is open too. `discoverMarked(collectModules(root), app,
metaOf)` walks the resolved module graph for methods carrying a marker of your
choosing, and `@JobHandler` in `@dunx/infra/queue` is that call with a job
marker. Mint your own key with `Symbol.for('acme.handler')` and it will not
collide with the framework's.

Two module rules matter more to a package than to an app. Bind every service
your package owns in one of your modules: an unbound class self-binds into
whichever scope resolves it first, and a second consumer is then a boot error.

Give a module that takes no options a plain `@Module` decorator instead of a
`forRoot()`. `forRoot()` returns a fresh object per call, so two importers build
two scopes.

## Test it the way it will be installed

`@dunx/testing` covers the module on its own:

```ts
import { createTestApp } from '@dunx/testing';

const app = await createTestApp({ modules: [GreeterModule] });
expect(app.get(GreeterService).greet('world')).toBe('hello world');
```

That run says nothing about your build. `bun link` and `bun add file:../pkg`
both resolve to your source directory, which sits outside `node_modules`, so the
consumer's plugin transforms your `.ts` files and a missing build step leaves no
trace. Install the tarball instead:

```sh
bun pm pack
cd ../consumer && bun add ../pkg/acme-thing-1.0.0.tgz
```

## Before you publish

- `dist/` holds the records: `grep -c 'dunx.deps' dist/index.js`
- `files` names `dist`, so `src/` stays out of the tarball
- `@dunx/core` sits in `peerDependencies`, at `^3.9.0` or later
- `"type": "module"`, and every relative import carries a `.js` extension
- a consumer installed from `bun pm pack` output boots
