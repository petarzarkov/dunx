# @arkv/logger: an abstract context contract

## Verdict

Do it, additively, as `@arkv/logger` 0.11.0. Two interfaces replace the one class at
`Logger`'s second parameter: `ContextReader` (one method, what the logger needs) and
`ContextScope extends ContextReader` (the three methods `ContextStore` already has).
`ContextStore` keeps its name, its root export, its behaviour and its place as the
ALS-backed default. Nothing downstream has to change. Baseline first: `cd
/home/petarzarkov/repos/arkv/packages/logger && bun test` gives `159 pass, 0 fail, 369
expect() calls, 10 files, 219 ms`.

The requirement is already measurable as a type error, and that finding decides the shape.
`ContextStore` declares `private readonly asyncLocalStorage`, which makes the class
**nominal**, so `Logger`'s `context?: ContextStore` parameter accepts `ContextStore` and its
subclasses and nothing else. dunx's own `AsyncRequestContext` implements the same three
methods and is rejected:

```
today.ts(7,33): error TS2741: Property 'asyncLocalStorage' is missing in type 'AsyncRequestContext' but required in type 'ContextStore'.
today.ts(10,33): error TS2345: Argument of type '() => { requestId: string; }' is not assignable to parameter of type 'ContextStore'.
```

Switching the field to `#asyncLocalStorage` would not help: `#` fields are nominal too. The
parameter type is what has to widen.

Two things this change is not, both checked rather than assumed. It does not make the
package loadable off Node: `node:fs` (`FileTransport`) and an unguarded `process.pid` at
`entry.ts:8` are on the root graph too. And it takes no number from the ALS-under-Bun
measurement; `scratchpad/research/async-context.md` does not exist as of writing.

## The contract

Split, because the halves differ in implementability. Reading fields is something a plain
object can do; propagating them across an `await` is something only ALS can do, and
requiring that of every implementation is the tie the owner asked to be cut. New file,
`packages/logger/src/context-contract.ts`:

```ts
import type { AsyncContext } from './types.js';

export interface RunWithContextOptions {
  /** Inherit the enclosing scope's fields. Default `true`. */
  inherit?: boolean;
}

/** The read side. The only thing `Logger` depends on. */
export interface ContextReader {
  getContext(): AsyncContext;
  /** The live fields, no copy, `undefined` outside any scope. Optional. */
  peekContext?(): AsyncContext | undefined;
}

/** The scope side: what a request pipeline needs, and what `ContextStore` is. */
export interface ContextScope extends ContextReader {
  updateContext(fields: Partial<AsyncContext>): void;
  runWithContext<T>(
    context: AsyncContext,
    callback: () => T,
    options?: RunWithContextOptions,
  ): T;
}

/** Everything `Logger`'s second parameter accepts. */
export type ContextSource =
  | ContextReader
  | (() => AsyncContext | undefined)
  | AsyncContext;

const EMPTY: AsyncContext = Object.freeze({});

export function asReader(source: ContextSource): ContextReader {
  if (typeof source === 'function') {
    return { getContext: () => source() ?? {}, peekContext: source };
  }
  if (typeof (source as ContextReader).getContext === 'function') {
    return source as ContextReader;
  }
  const f = source as AsyncContext;
  return { getContext: () => ({ ...f }), peekContext: () => f };
}
export function readContextOnce(r: ContextReader | undefined): AsyncContext {
  if (!r) return EMPTY;
  return r.peekContext ? (r.peekContext() ?? EMPTY) : r.getContext();
}
```

`RunWithContextOptions` moves here and `context.ts` re-exports it, so the root export keeps
working and there is one declaration. `ContextStore` gains `implements ContextScope` and one
method, `peekContext(): AsyncContext | undefined` returning
`this.asyncLocalStorage.getStore()`; its ALS, constructor and three existing methods are
untouched.

`Logger` changes in three places and nowhere else: the field becomes `readonly #context?:
ContextReader`, the constructor becomes `constructor(config?: LoggerConfig, context?:
ContextSource)` assigning `context === undefined ? undefined : asReader(context)`, and
`#shouldLog` folds into `#writeLog` (one caller, and it existed only to hide the second
read) as `const context = readContextOnce(this.#context)` after the `#minLevelIdx` gate,
with the `filterEvents` check reading `context.event` off that one value and `context`
handed straight to `createLogEntry`.

The second implementation the owner asked for, `packages/logger/src/request-context.ts`,
with no `node:` import at all: `RequestScopedContext implements ContextScope` over a
`#fields: AsyncContext` the constructor takes, `getContext` copying it, `peekContext`
returning it, `updateContext` an `Object.assign` onto it, and `runWithContext` a
save-and-restore of `#fields` around `callback()` in a `try`/`finally`, merging `{
...previous, ...context }` unless `inherit: false`. Its limit belongs in the doc comment:
save-and-restore is correct for a synchronous scope and for one instance per request, and
wrong for one shared instance across concurrent awaits. That is the Workers and
per-request-object pattern, and where a consumer with no `node:async_hooks` lands.

**Interfaces upstream, not abstract classes, and dunx pays nothing extra.** arkv has
no container, so an `interface` costs zero bytes and imposes no base class on an
implementation the consumer already owns. dunx's DI resolves classes, so an interface at a
dunx injection site is a boot error, but dunx already has the class it needs: the abstract
`RequestContext` at `packages/core/src/logger/context.ts:31`. A second abstract class
upstream would give dunx two tokens for one contract and every other consumer a base class
to extend for no reason. arkv owns the structural contract, dunx owns the nominal token
satisfying it, and the test below keeps them equal.

## What a consumer may pass

| Passed                                          | Accepted directly | How it is read                     |
| ----------------------------------------------- | ----------------- | ---------------------------------- |
| `ContextStore`, `RequestScopedContext`           | yes               | `peekContext()`, zero copy         |
| dunx's `RequestContext` / `AsyncRequestContext`  | yes               | `getContext()`, one copy           |
| any class with `getContext()`                    | yes               | `peekContext()` if declared, else `getContext()` |
| a plain object, read live                        | yes               | `peekContext()` over that object   |
| a zero-argument function                         | yes               | called per entry                   |
| a `Map`, `Headers`, a proxy                      | via the function  | `() => Object.fromEntries(map)`    |
| nothing                                          | yes               | frozen `EMPTY`, no allocation      |

A `Map` adapter is not worth shipping: the function arm covers `Map`, `Headers`, a getter on
a framework request object and anything else in one expression, and a `MapContext` class
would be a second thing to keep in step with `AsyncContext`.

Per-call cost of the union: none. `asReader` runs once in the constructor and stores one
`ContextReader`, so the per-entry path is one property check plus one method call, the shape
`this.#context.getContext()` already has today; the `typeof` chain never runs per entry.

The cost is at the type level. `AsyncContext` has an index signature, so the plain-object
arm accepts nearly any object: a reader whose method is misspelled `getContxt` compiles as
an `AsyncContext` and reads zero fields for the process's lifetime. No cheap runtime guard
exists (the property simply is not there), so it is documented rather than defended. The
alternative was dropping that arm and asking for `() => obj`, six characters, which keeps
full checking; the owner's wording is "accept anything the consumer passes it", so the arm
stays and the caveat goes in the README.

## The node:async_hooks question

Two answers, because the goal has not been stated.

**If the goal is pluggability**, this change is complete without touching the import:
`ContextStore` stays in `context.ts`, stays root-exported, `node:async_hooks` stays where it
is, and a consumer with no ALS passes `RequestScopedContext`, a plain object or a function
and never constructs `ContextStore`. Additive, minor bump. Recommended.

**If the goal is running on non-Node runtimes**, this change is not sufficient and
should not be sold as it. The root graph pulls three Node things and `node:async_hooks` is
only the first: `context.js` line 1 is `import { AsyncLocalStorage } from
'node:async_hooks';`, re-exported by `index.js`, so an unbundled ESM loader evaluates it on
`import '@arkv/logger'`; `file.js` imports `node:fs` for `FileTransport`, also
root-exported; `entry.ts:8` is `export const PID = process.pid;`, evaluated at load with no
guard. The README says as much already: "Framework-agnostic, but not runtime-agnostic", "It
is **not** built for the browser". Changing that is a package-wide scope change across three
items, and folding it in here turns an additive change breaking for no gain.

Measured, for whoever picks it up. `bun build --target=browser` over the built ESM,
`ContextStore` unused: 38 modules, 45.47 KB, zero references to `async_hooks` (tree-shaken).
`ContextStore` used: 45.51 KB and the import becomes `var {AsyncLocalStorage} = (() =>
({}));`, a stub. So a browser or edge bundle today either drops the store or builds clean
and throws `AsyncLocalStorage is not a constructor` on first use.

Mechanism then: a **subpath export**, `@arkv/logger/async-context`, mirroring the existing
`./testing` entry. All three build tsconfigs `include: ["src"]`, so a new
`src/async-context.ts` compiles into all three outputs with no build change; only the
`exports` map gains a key, and its `require` condition covers CJS. Every lazy-import
alternative is unavailable or worse: `await import()` at module scope needs top-level await
(banned by the CJS build), `createRequire` needs `import.meta.url` (banned), a bare `typeof
require !== 'undefined' && require(...)` resolves to `undefined` in the ESM output so ESM
consumers would silently lose ALS, and a consumer-called async factory cannot work because
`getContext()` is synchronous. Moving `ContextStore` off the root is the breaking half,
so version 0.11 adds the subpath alongside a deprecated root export, the next major
removes the root re-export, and `engines.node >= 18` plus the `nodejs` keyword stay
until then.

## The double read

`getContext()` runs twice per entry today: `#shouldLog` reads it for `ctx.event`, then
`#writeLog` reads it again for `createLogEntry`, and each call allocates a shallow copy.
Measured on Bun 1.3.14 inside a live scope holding four fields, N = 2,000,000 after 200,000
warmup iterations:

| Read pattern                       | ns/op |
| ---------------------------------- | ----- |
| `getContext()` twice (today)       | 83.4  |
| `getContext()` once                | 35.7  |
| `peekContext()` once, zero copy    | 8.8   |

Collapsing the double read saves 47.7 ns per entry and the zero-copy read another 26.9 ns
on top, for 74.6 ns in total. The first half is an internal reorder in `#writeLog` with no
contract change; the second is the optional `peekContext` above. What the copy protected: less
than it looks. It is a **shallow** copy, so every nested value was already shared by
reference with the live store, and both consumers of the value were probed against the built
ESM and neither mutates. `createLogEntry` spreads `parts.context` into a fresh `merged` and
does its `delete` on `merged`; handed a context carrying `level` and `message` (both
reserved, so the delete path runs) the passed object came back byte-identical.
`sanitizeLogEntry` masks into new objects; handed a nested `{ password, deep: { token } }`
through the context, the input was unchanged.

The one thing the copy does give is snapshot semantics for an external caller: `const a =
store.getContext(); store.updateContext({ x: 1 })` leaves `a.x` undefined. Public,
observable, asserted by nothing, and changing it would break for no benefit. So
`getContext()` keeps the copy and `peekContext()` is the new opt-in read, documented as
do-not-mutate; an implementation with no stable reference to give omits it and pays the
copy. The `has`/`get(key)` variant was rejected: it removes one allocation for the
`filterEvents` check but leaves the entry read, so it is two contract methods where the
single threaded read is one.

## Structural satisfaction with dunx, proven

dunx calls all three methods, so it needs `ContextScope` and not just the reader:
`runWithContext` at `packages/http/src/server/request-logging.ts:216,294` and
`packages/http/src/client/service.ts:152`, `updateContext` at
`packages/auth/src/context.ts:61`, `getContext` at
`packages/core/src/logger/console.ts:176,203`. None of those three signatures changes, so
`provide(RequestContext, { useFactory: (store: ContextStore) => store })` at
`packages/infra/src/logger/module.ts:104-107` compiles untouched.

Prototype at `scratchpad/arkv-logger-context/`, typechecked against both packages' real
built `dist/types` (confirmed with `--listFiles`: it loaded
`arkv/packages/logger/dist/types/*.d.ts` and `dunx/packages/core/dist/logger/context.d.ts`,
not stubs).

```
$ cd <scratchpad>/arkv-logger-context
$ /home/petarzarkov/repos/arkv/node_modules/.bin/tsc -p tsconfig.json --noEmit; echo "exit=$?"
exit=0
```

Zero diagnostics. `prove.ts` asserts in one pass that `ContextStore` satisfies dunx's
`RequestContext` (today's binding, unchanged) and both halves of the new contract; that
`AsyncRequestContext`, an abstract `RequestContext` reference and `RequestScopedContext`
satisfy both halves, the first two with `peekContext` absent; that `ContextSource` accepts
all of those plus a plain object, a function returning fields, one returning `undefined` and
a `Map` via `Object.fromEntries`, and rejects `42` and `'requestId'` under
`@ts-expect-error`, so the exit 0 is a real check.

Negative control, so the exit 0 is not vacuous. `drift.ts` renames `runWithContext` to
`withContext` on a store, the way an upstream release could:

```
$ /home/petarzarkov/repos/arkv/node_modules/.bin/tsc -p tsconfig.drift.json --noEmit; echo "exit=$?"
drift.ts(20,7): error TS2741: Property 'runWithContext' is missing in type 'DriftedStore' but required in type 'RequestContext'.
drift.ts(21,7): error TS2741: Property 'runWithContext' is missing in type 'DriftedStore' but required in type 'ContextScope'.
exit=1
```

Both repos are on TypeScript 7.0.2. `tsc -p tsconfig.build.cjs.json --noEmit` in the logger
exits 0 today, so a new `src/*.ts` file builds in all three configurations.

## Migration and version

**Additive.** No existing name changes and no existing signature narrows.
`ContextStore` stays root-exported and stays the default, plus one new method. `Logger`'s
second parameter widens from `ContextStore` to `ContextSource`, which is source-compatible
for every caller since `ContextStore` is assignable to `ContextSource` (asserted above); the
only thing that could break is code reading `ConstructorParameters<typeof Logger>[1]` and
assigning into it, and neither repo has any. Five new names off the root: `ContextReader`,
`ContextScope`, `ContextSource`, `RequestScopedContext`, `asReader`. Version: `@arkv/logger` goes
from 0.10.0 to **0.11.0**, off a `feat(logger):` subject, which is what
`scripts/version.ts` reads as a minor.

Ordered republish:

1. **`@arkv/logger` 0.11.0.** Self-contained, ships alone.
2. **`@arkv/nestjs-context-logger`, next patch.** No source change:
   `ContextService extends ContextStore` compiles unchanged and inherits `peekContext`.
   It still needs the republish, because `version.ts` rewrote its `workspace:^` to
   `^0.10.0` in the tarball and `^0.10.0` excludes 0.11.0 under 0.x caret rules.
   Change detection sees no file change there, so cut it with
   `[force-publish:@arkv/nestjs-context-logger]`.
3. **`packages/nestjs-cms`: nothing.** No reference to `ContextStore`,
   `ContextService`, `getContext` or `runWithContext` in its source.
4. **dunx `@dunx/infra`.** `@arkv/logger` `^0.10.0` to `^0.11.0` in
   `packages/infra/package.json`, plus the drift test below, `release(minor):`;
   `src/logger/module.ts` needs no edit.
5. **dunx `@dunx/core` and `@dunx/infra`, separate release, optional.** Add
   `peekContext?(): RequestFields | undefined` as an optional member of `RequestContext`
   and implement it on `AsyncRequestContext`, so core's default store gets the 8.8 ns
   read too. Optional, so nothing breaks. Hold it for the ALS spike, which may change
   what core's default should be.

## Tests that go in

Failing first, per arkv's rule; items 1, 3 and 4 do not compile or do not pass against
today's `Logger`. **New, `packages/logger/src/context-contract.test.ts`** (about 120 lines,
leaving `context.test.ts` at 90 and both far under 500):

1. `reads a store that is not a ContextStore` - a hand-written class with the three
   methods, handed to `new Logger({ transports: [memory] }, store)`, asserting
   `memory.last.requestId`. The owner's requirement as one test. Fails to compile
   today: `TS2741: Property 'asyncLocalStorage' is missing`.
2. `reads a plain object live` - build the logger over `const fields = {}`, then
   `fields.requestId = 'r-1'`, then log, assert the entry carries it. Locks live
   reading rather than a construction-time snapshot.
3. `reads a zero-argument function`, and `logs no context fields when the function
   returns undefined`.
4. `prefers peekContext over getContext` - a reader counting both, asserting exactly
   one `peekContext` and zero `getContext` per entry. Then
   `falls back to getContext when peekContext is absent` on the same counter,
   asserting exactly **one** call per entry, not two. Fails today, where it is two.
5. `does not mutate the fields it read` - context carrying `level` and `message`,
   both reserved, so `createLogEntry`'s delete path runs; assert the live object is
   unchanged and the entry reports them under `reservedFieldConflicts`.
6. `filterEvents still drops an entry` through each of the four source forms.
7. `RequestScopedContext`: nested scopes merge, `inherit: false` starts clean, the
   previous scope is restored when the callback throws, two instances stay
   independent. Mirrors the five existing `ContextStore` cases, which shows the
   second implementation is the same contract and not an approximation.

**`packages/logger/src/exports.test.ts`** (+8): the five new names resolve off
`./index`, the guard that caught `sanitize.ts` shipping unexported.
**`packages/logger/src/context.test.ts`** (+10): `peekContext()` returns the live object
inside a scope and `undefined` outside one, and mutating what it returns is visible to
`getContext()` - the documented hazard, asserted so it cannot soften silently.

**dunx `packages/infra/src/logger/module.test.ts`** (+20), the analogue of the `LOG_LEVELS`
test at line 35. That one compares two arrays at runtime because a silent upstream rename
typechecked and disabled level filtering. The same hole exists here, in the direction the
compiler does not cover:

```ts
/**
 * The `provide(RequestContext, ...)` factory holds only while the two declare the
 * same three methods. A rename upstream is a compile error at that line, but only
 * while `dist/` is fresh, and the reverse direction is unchecked: core's own
 * `AsyncRequestContext` has to stay acceptable to `@arkv/logger`'s `Logger`.
 */
it('keeps arkv and core context stores interchangeable, both directions', () => {
  const CONTRACT = ['getContext', 'updateContext', 'runWithContext'] as const;
  const upstream: RequestContext = new ContextStore();
  const core: ContextSource = new AsyncRequestContext();

  for (const name of CONTRACT) {
    expect(typeof upstream[name]).toBe('function');
    expect(typeof (core as RequestContext)[name]).toBe('function');
  }
  expect(new ArkvLogger({ transports: [] }, core)).toBeInstanceOf(ArkvLogger);
});
```

The `typeof` loop is what makes it fail at test time rather than only at compile time, the
property the `LOG_LEVELS` test has and a `satisfies` would not.

## Risks and open spikes

- **The ALS spike this plan does not wait on.** If merely loading `node:async_hooks`
  deoptimises async functions process-wide under Bun, upstream pluggability alone buys
  dunx nothing, because `@dunx/core` imports it for `AsyncRequestContext` whatever
  `@arkv/logger` does. That lands in step 5, last for this reason; steps 1 to 4 need
  no number from it.
- **The plain-object arm erodes type checking**, per "What a consumer may pass".
  Documented, not guarded.
- **`peekContext` hands out the live object.** Both current consumers were probed and
  neither mutates, but a future transport or formatter that mutates its entry would be
  mutating live context. The existing copy was shallow, so nested values already had that
  exposure; the new surface is the top-level object only.
- **Non-Node loadability is three items, not one.** Reading this plan as "the logger
  now runs on Workers" is wrong until `node:fs` and `process.pid` are handled too.
- **arkv's CLAUDE.md says TypeScript 6.x; the repo is on 7.0.2.** Unrelated, worth a
  one-line fix.
- **Open, needs the owner:** pluggability or non-Node? The plan delivers the first and
  lays out the sequence for the second. Also open: whether `RequestScopedContext` is the
  right name, given dunx already owns `RequestContext` and `AsyncRequestContext`.

## Cost

`@arkv/logger`, six files plus tests: about 290 lines added and 21 removed, no file
anywhere near the 500-line cap.

| File                      | Change                                                          | LOC     |
| ------------------------- | --------------------------------------------------------------- | ------- |
| `src/context-contract.ts` | new: two interfaces, the union, `asReader`, `readContextOnce`    | +50     |
| `src/request-context.ts`  | new: `RequestScopedContext`                                      | +40     |
| `src/context.ts`          | `implements ContextScope`, `peekContext()`, re-export the options | +8/-5   |
| `src/logger.ts`           | field type, constructor normalizes, `#shouldLog` folds in         | +10/-16 |
| `src/index.ts`            | five new exports                                                 | +6      |
| `README.md`               | the contract, the accepted forms, the caveat, the Node stance     | +40     |
| tests                     | +120 contract, +10 context, +8 exports                           | +138    |

Downstream: `@arkv/nestjs-context-logger` changes nothing in source and needs a forced
republish so its pinned `^0.10.0` moves. `packages/nestjs-cms` changes nothing, having no
reference to any affected name. dunx `@dunx/infra` changes one dependency range plus the
drift test, `src/logger/module.ts` untouched. dunx `@dunx/core` changes nothing required,
optionally +6 for the optional `peekContext`, worth 74.6 ns per entry and held for the ALS
spike. `@dunx/http` and `@dunx/auth` change nothing; they call the three unchanged methods.
