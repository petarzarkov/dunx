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

Three other ways of building do not work. `bun build --outdir dist` cannot load
a plugin from the command line. `tsc` alone does not run the transform. If you
ship `.ts` sources, the consumer's preload skips them, because it skips everything
in `node_modules`.

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

`AppFactory.create` fails at boot if it finds more than one copy, and the error
says why. Copies from releases older than that check are not detected.

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

Each one is an abstract class, because a constructor parameter must name a
runtime value for injection to work. Subclass it and bind your subclass in your
module. The application then injects the contract.

`Middleware` is different. It is an interface, and you register the class that
implements it. A guard throws, an interceptor wraps `next()`, and a filter maps
the error. A module's `middleware` array applies only to that module's own
controllers. To apply it more widely, the application has to call
`app.use(YourMiddleware)`, so say so in your package's README.

Handler discovery is open too. `discoverMarked(collectModules(root), app,
metaOf)` walks the resolved module graph for methods carrying a marker of your
choosing, and `@JobHandler` in `@dunx/infra/queue` is that call with a job
marker. Mint your own key with `Symbol.for('acme.handler')` and it will not
collide with the framework's.

Two module rules matter more for a package than for an app. First, bind every
service your package owns in one of your modules. An unlisted class is registered
in whichever module asks for it first, and a second module that asks for it then
fails at boot.

Second, give a module that takes no options a plain `@Module` decorator instead
of a `forRoot()`. `forRoot()` returns a fresh object per call, so two importers build
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
