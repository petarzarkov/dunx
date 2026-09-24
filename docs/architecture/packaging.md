# Building, packaging and releasing

How the packages are built, why versioning is lockstep, and what the scaffolder resolves at run time.

## Build & packaging

Bun-only, so the ESM/CJS/types triple build is wasted work.

- **ESM only.** One `tsconfig.json` per package.
- `Bun.build` emits JS: `target: 'bun'`, `format: 'esm'`,
  `packages: 'external'` (relative imports bundle, dependencies stay external),
  `sourcemap: 'linked'`.
- `tsc --emitDeclarationOnly` emits the `.d.ts` tree. Bun has no `--dts`.
- Relative imports in source **must** carry a `.js` extension. `tsc` copies the
  specifier verbatim into `.d.ts`, and an extensionless specifier fails to
  resolve for consumers on `moduleResolution: node16`/`nodenext`.
- `"type": "module"` is required in every package manifest. Without it,
  `verbatimModuleSyntax` reports `TS1287` against ESM syntax.

Both halves run from the shared `scripts/build-package.ts`, so there is one
implementation for every package.

`tools/*` builds exactly like `packages/*`, through the same script: those
workspaces are published too, and `bunx @dunx/create-app` is the point of them. The
parent says what a workspace **is**, not whether it ships.

`internal/*` sits outside all of this. Those workspaces are `"private": true`,
never published, and build with whatever suits them - `internal/docs` is a React
bundle, not a `Bun.build` package. The dependency rules constrain what dunx ships.
They do not constrain what builds its website or measures it.

## Scaffolder (`create-app`)

Covered in [tooling.md](./tooling.md#dunxcreate-app-asks-with-an-arrow-key-list-and-takes-no-prompt-library).

## Versioning is lockstep, as a correctness requirement

Every `@dunx/*` package shares one version and is published together, even when a
release touches only one of them. Change detection decides _whether_ to release,
never _what_.

This is not tidiness. The publish path rewrites a `workspace:*` range to a concrete
one when it packs a tarball, because `npm publish` leaves the `workspace:` protocol
untouched. With independent versions that produces:

```
@dunx/http@0.2.0   ->  "@dunx/core": "^0.1.0"
@dunx/infra@0.3.0  ->  "@dunx/core": "^0.2.0"
```

An app installing both gets **two copies of `@dunx/core`**. In this container a
token _is_ a class object: `provide(Logger, …)` keys a `Map` by the class itself.
So two copies means two distinct `Logger` classes, and `app.get(Logger)` misses
the binding another package registered. It fails silently, at boot, with a
message about a missing provider for a token the user can plainly see is bound.

`Symbol.for('dunx.deps')` was already chosen so duplicate copies of core still agree
on the deps key. Class identity cannot be made to agree, so the duplicate has to be
prevented instead.

Two alternatives were considered and rejected:

- **Caret ranges _instead of_ lockstep.** Pre-1.0 `^0.1.0` excludes `0.2.0`, so a
  minor bump of core still fragments the graph. `^` only helps within a patch series.

Caret ranges **on top of** lockstep are a different question, and they are now
what ships: `workspace:*` publishes as `^<version>`. Every internal range is a
`peerDependency`, and an exact peer accepts exactly one version. So npm answers
a consumer one patch ahead with an `ERESOLVE` failure, and bun answers with a
warning plus a nested copy.

A caret is never worse than exact - exact excludes `0.2.1` too - and under
lockstep it can never be stale, because every package in a release names the
same version as the peer it declares. What the caret does _not_ do is survive
independent versions. Lockstep stays for that reason.

- **`@dunx/core` as a `peerDependency`.** This was rejected here and has since been
  **adopted**; the entry stays because the reason it was rejected is the useful
  part. Peers are the textbook answer, and they resolve to one copy. But
  `bun run --filter '*' build` orders builds by `dependencies` alone, so moving
  core to a peer raced `tsc` against core's own `.d.ts` emit and failed with
  `TS7016`. The fix was a topological build rather than a different dependency
  shape.

`scripts/build-all.ts` now orders by `dependencies`, `peerDependencies` and
`devDependencies`, and `@dunx/core` and `@dunx/http` are peers with a matching
`devDependency` supplying the workspace link. Re-measured from a clean tree:
`--filter '*' build` still fails with `TS7016`, `bun run build` does not.

**Peers are a second guarantee rather than a replacement for lockstep.** A peer cannot be
duplicated by the installer; lockstep keeps the version `version.ts` writes into
that peer range coherent across the set. Independent versions on top of peers is
the remaining prize, and the range policy it needs was the one thing a caret
could not supply pre-1.0.

The cost of lockstep is that an untouched package still takes a version. For a
set whose packages move together anyway that is a feature: one number answers
"which versions work together", the question a consumer of six packages actually
has.

**Decided: lockstep stays.** The trigger this section used to name was
`@dunx/core` reaching 1.0.0, on the argument that no pre-1.0 range could work: a
caret cannot span a `0.x` minor, so `@dunx/http@0.3.0` naming `@dunx/core@^0.2.0`
while `@dunx/infra@0.4.0` names `^0.3.0` was an unsatisfiable peer set. `>=x.y.z`
installed cleanly but promised compatibility across every future major.

That trigger has passed. A caret now spans the whole major, so the range policy
independent versions were waiting for exists, and the blocker in the paragraph
above is spent. What keeps lockstep is the rest of the case: one number answers
"which versions work together", and the caret `resolveWorkspaceRange` writes can
never be stale while every package in a release names the same version.

Reopening it now needs someone who wants independent versions and will carry the
duplicate-copy risk, rather than a version number. `AppFactory.create` counts
loaded copies of core and refuses to boot on more than one, so that risk is at
least loud.

A third party publishing against these packages declares
`"@dunx/core": "^3.9.0"` as a `peerDependency`; see
[the publishing guide](../guide/30-publishing-a-package.md).

The thing to avoid is treating lockstep as an accident. It is load-bearing,
and `resolveWorkspaceRange` writing `^<version>` is only sound _because_ every package
in a release names the same number.

## Test harness (`@dunx/testing`)

The container is scoped: every module reference is its own scope, described in
[Modules encapsulate](./dependency-injection.md#modules-encapsulate-exports-global-and-a-scope-each).
How an override behaves across those scopes is specified in
[Overrides replace in every scope](./dependency-injection.md#overrides-replace-in-every-scope).
What follows is the decisions that specification did not cover.

**The substitution lives in `@dunx/core`, as `AppFactory.create(root, {
overrides })`.** `createTestApp` cannot build the scopes itself: `Injector` and
the scope builder are not exported. Exporting the container would freeze its
shape as public API, and a testing package that duplicated the build-resolve-
`onInit` loop would be a second container to keep in step with the first.

So core grew the seam, and `@dunx/testing` is a thin wrapper over it. After the
scopes are built, each override replaces the token's binding in every scope that
binds it (`own`) and every scope that sees it through an import (`visible`),
keeping the original binding's module name for error messages. With no overrides
passed, that is an empty `Map` lookup per binding.

The seam is `readonly Registration[]` rather than a test-shaped API: it is "compose this
graph with these bindings replaced", which is also how a deployment variant would
be expressed. `HttpOptions extends AppOptions`, so the HTTP factory inherits it
without a second mechanism.

**The always-bound defaults are substituted too.** `Logger` and `RequestContext`
are offered by `registerDefault` after every module, so nothing in the module graph
binds them in a typical app. An override of `Logger` would therefore have been
"nothing to override." They are now built as a `Registration[]` and run through the
same substitution, which makes silencing the logger in a test possible at
all. The unmatched-override check runs after both stages.

**`requestLogging` defaults to `false` in `createTestServer` only.** The framework
default stays on. A suite is the one context where one structured line per request
is pure noise, and the alternative - every suite passing `requestLogging: false` -
is a default in the wrong place. Asserting on request logging means asking for it.

**An omitted `middleware` warns rather than becoming a type error.** Every other
`HttpOptions` field is absent unless passed. For `middleware` and `onError` that
means a fixture with no global guards and the default error mapper: it boots, it
answers 200 where the application answers 401, and it says nothing. This was
reported from a port of `nestjs-template`, as a first integration run of 12 pass /
10 fail.

Three fixes were on the table. **Requiring the fields** (a present key that may
be `undefined`, which `exactOptionalPropertyTypes` makes a real obligation) was
rejected: it is loud in the right cases and noise in the majority, where an app
has no globals at all, and it breaks every existing suite. **Documenting the
shared `httpOptions(config)`** is done, in guide 10. It is the actual fix,
because one definition of the application cannot drift.

**The warning** is the guard for the case where documentation was not read: a
class provider whose prototype has a `handle` method is a `Middleware`, and if
no `@UseGuards` attaches it and no `middleware` was passed, `createTestServer`
writes one `console.warn` naming it.

Two details matter here. First, excluding route-scoped guards means the warning
has no false positive on the common `@UseGuards` case: those are in the route
table and cost the omission nothing. It does cost a second `discoverRoutes` pass
over the controllers at fixture boot, which is boot-time work in tests only.
Second, it goes to `console.warn` rather than the bound `Logger`: a suite
asserting `recording.entries` is empty must not find an entry the application
never wrote. `middleware: []` is the opt-out, because "none, intentionally" is
expressible and "forgot" is not.

**`@dunx/core` and `@dunx/http` were initially `dependencies` at `workspace:^`
rather than peers - measured, not assumed.** Peers are the better contract: a
second copy of core in a consumer's tree is a second `Logger` class, and
therefore a token that matches nothing. Overrides would then silently replace
nothing, exactly the failure the unmatched-override error exists to prevent.
Peers did not survive the build at the time; the topological build fixed that,
and **peers are now in use**. The measurement below is kept because it explains
why the build had to change first.

`bun run --filter '*' build` derives its ordering from **`dependencies` only**.
Measured on Bun 1.3.14: with core in `devDependencies` and in `peerDependencies`
(both tried, including a `workspace:` range in the peer field), `@dunx/testing`'s
`tsc` ran concurrently with core's own build and failed with `TS7016: Could not
find a declaration file for module '@dunx/core'`. `build-package.ts` deletes
`dist/` before writing it, so in CI, where no `dist` exists at all, that is not a
race but a certainty.

Two consequences worth keeping:

- The range publishes as a **caret** rather than an exact version. An exact pin
  makes `@dunx/testing@0.4.0` demand `@dunx/core@0.4.0` and nothing else, so a
  consumer on 0.4.1 gets a nested second copy (Bun warns and installs it;
  npm fails with ERESOLVE) - the duplication being avoided.
  **That pass has since been taken for every package**: `workspace:*` no longer
  publishes as the exact version, it publishes as `^<version>`. The rule lives in
  one place (`resolveWorkspaceRange` in `scripts/workspace-ranges.ts`), shared by
  `version.ts` and `first-publish.ts`.

The source form stayed `workspace:*` everywhere. `scripts/manifests.test.ts`
asserts that, and it is what keeps a concrete version from being left behind by
an aborted publish.

This was a partial fix while dunx was pre-1.0, because `^0.4.0` is
`>=0.4.0 <0.5.0` and `version.ts` only republishes packages whose own `src`
changed: a core-only **minor** bump left a published `@dunx/testing` pointing at
the previous minor, and the nested copy returned. At `3.x` a caret spans the
major, so a minor bump no longer strands anything. A **major** bump still wants
the whole set republished, which lockstep does anyway.

- **A published package's tests cannot import a workspace package that is not one
  of its runtime dependencies.** The first draft converted
  `packages/openapi/src/module.test.ts` to the harness. A package's build
  typechecks its own tests, so that made openapi's build race `@dunx/testing`'s.
  Putting `@dunx/testing` in openapi's `dependencies` would have shipped a test
  package to production, so this was reverted. `examples/*` have no such limit:
  nothing builds in parallel with them, so `examples/full/src/service.test.ts` is
  where the harness is exercised against a real app.

`@dunx/http` is therefore not optional, and `createTestServer` imports it normally.

**No `providers` key on the options.** `{ modules, overrides }` is the documented
shape and stays that shape. A `providers` list would make the harness able to
assemble graphs that do not exist in the app, which is how a suite ends up
asserting against a container the production app never builds. A fixture class that
needs binding goes in a two-line `@Module` - where it would live if it were real.

**Two request helpers, no assertion DSL.** `json()` returns `{ status, headers, body }`
and `request()` returns the `Response`. A JSON body is `json:` on the init object
rather than a `post`/`put`/`patch` triple, so every verb is one call shape.
`json()` reads text before parsing so a 204, an HTML error page or a plain-text
body fails with the status and content-type rather than with `JSON.parse`'s
message. `RecordingLogger` is the one other helper, earned by the contract being
seven levels of three overloads: it records and interprets nothing.

**`prefix` is `string | undefined` where every other option is not.** A suite that
runs one fixture prefixed and unprefixed passes a variable, and under
`exactOptionalPropertyTypes` that is otherwise a conditional spread at the call
site. "No prefix" and "absent" are the same state here, so nothing is lost - this
is not a licence to widen options where they differ.
