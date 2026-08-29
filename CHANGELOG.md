# Changelog

Every release, newest first. Written by `bun run version` from the commits in the
release range. Every @dunx package shares one version and ships together, so a
release covers all of them.

## 3.1.1 - 2026-08-29

A config schema, and contributions as providers

`ConfigModule.forRoot` takes either `validate` or `schema`, and the type makes it
exactly one. A Standard Schema is validated directly, so zod, Valibot and ArkType
all work with no wrapper; its issues become a `ConfigError` naming each path.
`StandardSchemaV1` moved from `@dunx/http` down to `@dunx/core`, which both
needed, and `@dunx/http` re-exports the three names unchanged.

`contribute` in `@dunx/openapi` also takes anything with a `contribute()` method,
so a contributor that needs an injected instance is a provider rather than a
closure over one. `DocumentSource` is the class to extend, and anything with the
method satisfies it structurally.

Both are additive: every existing `validate` and every fragment or thunk keeps
working.

### Features

- **core,openapi**: a Standard Schema for config, and contributions as providers ([`cd3fbf8`](https://github.com/petarzarkov/dunx/commit/cd3fbf87c8e962a0076fa71c05c339b3912493a2))

### Documentation

- retire the class-modules note, per the folder's own rule ([`3eb567c`](https://github.com/petarzarkov/dunx/commit/3eb567c5fc00b8ca3dc244c7e905249fff349322))

## 3.1.0 - 2026-08-29

Options as providers, constraint statuses, and the 1.4 fetch options

`HttpOptionsProvider` carries every HTTP setting and is resolved from the
container, so a subclass injects `ConfigService` and answers from validated
config. `AppOptions.promote` in `@dunx/core` is what binds it: core's own
mechanism for `Logger` and `RequestContext`, now callable by a framework layer.
An argument to `create()` still wins field by field, and `setGlobalPrefix`,
`enableCors`, `set` and `enableShutdownHooks` are unchanged, each with a field
alongside it applied at construction.

`WsRelayModule` binds the websocket relay as a provider and closes it at
shutdown, which `PubSub.close()` does not do for an app that never opened a
socket.

A named instance can be a subclass rather than a token, in both packages that had
a token function: `HttpModule.forRoot(init, EmailClient)` in `@dunx/http/client`
and `RedisModule.forRoot(init, SessionsRedis)` in `@dunx/infra/redis`. A subclass
is a token and a parameter type, so it resolves as a constructor parameter.
`Redis` is newly exported as the base to extend. Both string forms still work.

`toDatabaseError` in `@dunx/infra/db` turns a driver constraint error into a
`ConstraintError` carrying a status, 409 for unique and foreign key and 400 for
not-null and check, through `AppError.status`, so nothing there imports the web
layer. The driver's message stays on `cause` rather than in the response body.

`HttpClientOptionsInit` passes `compress`, `protocol` and `maxRedirects` to
fetch, and `proxy` widens to Bun's object form.

One behaviour change: an unmatched path answers 404 rather than 401 in an app
behind a global guard. `notFound: 'guarded'` restores it. `docs/guide/22-upgrading.md`
covers each item.

### Features

- **http**: WsRelayModule, so the websocket relay is a provider ([`1092aa5`](https://github.com/petarzarkov/dunx/commit/1092aa564a3850c8c74552644b7ea6c0feea5936))
- **infra**: a named Redis connection can be a subclass, and CodeRabbit's findings ([`ba4d788`](https://github.com/petarzarkov/dunx/commit/ba4d7885aa291583b8f24dec45f5f53812e74e87))
- **bench,http**: the 1.4 fetch options, profiling in the harness, and A1/A5 measured ([`093fafe`](https://github.com/petarzarkov/dunx/commit/093fafe56a741351a2c7c12375c5a32008c38c17))
- **http**: a named outbound client can be a subclass, not only a token ([`16caace`](https://github.com/petarzarkov/dunx/commit/16caacec92bcce496c610a9ae8d10cebdf462eda))
- **http,infra**: HTTP options as a provider, and constraint errors that carry a status ([`073bed3`](https://github.com/petarzarkov/dunx/commit/073bed38d4448c9b081d9579064cbd82cd393d8f))

### Fixes

- **examples,create-app**: isolate the sessions database, and write every env entry ([`8f096b3`](https://github.com/petarzarkov/dunx/commit/8f096b306cada16b4b981ba3f6b8c5127aabbaf1))
- **bench,http**: unprofiled startup samples, and a provider that can express shutdownHooks ([`ad1add5`](https://github.com/petarzarkov/dunx/commit/ad1add54ab333e8d96515d3fd884f11d3c90cf6d))

### Documentation

- **roadmap**: assign trustProxy in the W1b snippet, as the real example does ([`2e1ae4c`](https://github.com/petarzarkov/dunx/commit/2e1ae4c109a9cd9f5bc9193cd72d8d9cff771844))
- link the filed bullmq issue for the worker shutdown hang ([`7494647`](https://github.com/petarzarkov/dunx/commit/7494647b7bd06ffbba5ab8234146c941e165b60c))
- **roadmap**: record W1/W2/W6/W0 shipped, W1b withdrawn, A1-A5 settled ([`c733f30`](https://github.com/petarzarkov/dunx/commit/c733f3024a13cc128d9289771f954af6f3ac9338))
- an upgrading guide, and leak B narrowed out of Bun ([`1c564db`](https://github.com/petarzarkov/dunx/commit/1c564db451ed2fe07e337df8907f7d6bc5bf3317))

## 3.0.5 - 2026-08-29

Errors carry their own status, and the logger drains on the way out

`AppError` gained an optional `status`, and `@dunx/http`'s default mapper honours
any error that names one. An integer is not the web layer, which is what lets
`@dunx/infra` say what a failure means without importing `@dunx/http` to say it:
`CursorError` and `PageOptionsError` declare 400, so a bad cursor is a 400 in an
app that wrote no `catch`. The status is range-checked, because it is typed by hand
in a package that never sees a `Response` and a typo would otherwise throw a
`RangeError` from the error path itself. A 4xx is no longer logged as an incident.

`@arkv/logger` moved to 0.12, which brings the HTTP, syslog and sampling transports
and the `textFormat`/`logfmtFormat` renderings, all re-exported from
`@dunx/infra/logger` rather than restated. `LoggerLifecycle.onShutdown` now drains
with `closeAsync`: a transport whose sink is a network discards its queue on a
synchronous `close()`, so an app shipping to a collector lost its last batch on
every deploy.

`examples/full` reads `LOG_FORMAT` and asserts the 400 end to end.

### Features

- **core**: an error carries the status it means, whoever raised it ([`57e0fb5`](https://github.com/petarzarkov/dunx/commit/57e0fb5661d21964ea99079af22b1dd143d8749f))
- **infra**: @arkv/logger 0.12, and drain the logger on the way out ([`d557dd7`](https://github.com/petarzarkov/dunx/commit/d557dd7f7661df07f82cd3add7078c16ccc29750))

## 3.0.4 - 2026-08-29

A scaffolder you answer, not one you configure

`bunx @dunx/create-app my-api` opens an arrow-key list instead of taking flags for
what the app should do. Space toggles a feature, Enter takes the selection, and the
two lines under the list recompute as the cursor moves: which features the selection
pulls in, and which of them need Redis or Postgres running to do anything. Neither
is something a flag could show.

`--with`, `--all`, `--list` and `--template` are gone. `scaffold({ target, features })`
is the scripted path, and `FEATURES` is exported beside it. `--name`, `--force`,
`--yes` and `--help` remain, none of which chooses anything about the app. Piped or
in CI it asks nothing and writes the minimal template, so a script never blocks on a
question nothing can answer.

No prompt library arrived with it. `setRawMode` is a `node:tty` built-in Bun
implements natively, `Bun.stringWidth` and `Bun.sliceAnsi` measure and cut by
terminal columns, `Bun.color` paints and `Bun.enableANSIColors` is the capability
check. Bun 1.4 also ships `Bun.Terminal`, an undocumented PTY, so the suite answers
the real CLI with real arrow keys rather than asserting against a mock of a terminal.

A generated app also gains `bun run dev` and loses two files. `src/bootstrap.ts`
exported `createApp` while `src/main.ts` declared a local function called `bootstrap`
that imported it; there is one file now, serving under `import.meta.main`.
`src/worker.ts` and its `worker` script were dead on arrival: `QueueModule` opens the
bullmq workers itself and a `background: true` handler is forked into
`jobs/jobs.processor.ts`.

Note for anyone scripting the CLI: the four removed flags exit with "Unknown option"
rather than being ignored, so a pinned range that expected them needs the
programmatic `scaffold` call instead.

### Features

- **create-app**: pick what the app does from a list, not from flags ([`4d1df4d`](https://github.com/petarzarkov/dunx/commit/4d1df4d3bbf7ac1e978cceca1bdc9ed46c005bb5))
- **docs**: a spark that laps the hero headline ([`8ad9894`](https://github.com/petarzarkov/dunx/commit/8ad98946b8217cd63bea90101e0f8f4576b3e1e5))
- **docs**: run a request through the landing page's onion diagram ([`13d7673`](https://github.com/petarzarkov/dunx/commit/13d76732f68850e11771b91fad5feda569332248))

### Fixes

- **ci**: keep a gitignored tmp/ scaffold out of the test sweep ([`f6df3c8`](https://github.com/petarzarkov/dunx/commit/f6df3c8c428a67a7d6f6f06c909d322448abbf62))
- **docs**: guard the sheen variable, and the observer stub's own contract ([`6e304e5`](https://github.com/petarzarkov/dunx/commit/6e304e588a717f1f8e064f55f14164bb43773418))

## 3.0.3 - 2026-08-27

The scaffolder exits, and setup instructions an agent can fetch

Both from feedback on r/bun.

`bunx @dunx/create-app my-api` wrote the app, printed its next steps and then sat
there until the user pressed Ctrl+C. The feature prompt read one line with
`console[Symbol.asyncIterator]().next()`, which never ends the iteration, so the
stdin handle stayed referenced for the life of the process. A piped run always
exited, because EOF ends the iteration on its own, which is why the CLI suite
stayed green for weeks. Six ways out were probed on Bun 1.4.0 and recorded in
docs/bun-apis.md; the test now spawns the reader with a pipe it deliberately does
not close.

Starting a project with an agent had nothing to point at. There is now a setup
document served raw at https://petarzarkov.github.io/dunx/setup.md, so "set up my
project using that URL" is a usable instruction, and an llms.txt beside it linking
every dunx document as fetchable markdown. Every scaffolded app also gets an
AGENTS.md naming its layout, its commands, the services its features want running
and the rules dunx fails at boot over, plus a CLAUDE.md pointing at it. Neither
copies the framework's own instructions: both link setup.md, which moves with each
release.

A patch rather than a minor, stated outright rather than derived. No package API
changed: the scaffolder writes two more files, and the rest is documentation.

### Features

- **create-app**: setup instructions an agent can fetch, and AGENTS.md per app ([`c94c241`](https://github.com/petarzarkov/dunx/commit/c94c241dce9f25edc30cfab21aa4a27e35a7e02d))

### Fixes

- **create-app**: exit after the feature prompt instead of hanging ([`5fc5d6f`](https://github.com/petarzarkov/dunx/commit/5fc5d6fc2ffd62ddf5030e1d00e4dbfd95e0995e))

## 3.0.2 - 2026-08-26

Field notes from a NestJS migration

Four changes and a documentation pass, all from one production NestJS/Bun
application's move to 3.0.1, plus the two Dependabot alerts on the benchmark
harness.

`config.get('db.host')` reads a dotted path, up to three segments, checked
against the config type the way a top-level key already was. `asSqlite(connection)`
narrows `DbConnection.raw` with a check rather than the cast a SQLite app needed
for pragma and trigger work. `consume: 'if-any'` lets queue wiring land several
commits before the first `@JobHandler`, which is what an incremental migration
does. And `ClientAddress.of()` returns `10.0.0.1` where it used to return
`::ffff:10.0.0.1`, the same address in the notation every caller was converting
it to.

**A patch rather than a minor, stated outright rather than derived.** Three of
the four are additive API, which semver would call a minor; the version is set
by hand for that reason and this note is where that is on the record.

**One thing to read before upgrading.** An app that stored the IPv4-mapped form
and compares those rows against `ClientAddress.of()` stops matching until the
stored values are normalised too. Nothing else changes an existing call: a
config key that itself contains a dot is still read whole, and every `get` written
before paths returns exactly what it did.

The migration also corrected the documentation it had been misled by. The
`.js`-extension warning is now conditional on `moduleResolution`, since it is a
large diff under `nodenext` and no diff at all under `bundler`. A type alias in a
constructor is its own boot-failure item. The `@nestjs/throttler` row said
`undesigned` while five exports ship.

### Features

- **core**: dotted paths in ConfigService.get ([`900da71`](https://github.com/petarzarkov/dunx/commit/900da713ad60eb0eeb8a3800f6287df4f4f46bfb))
- **infra**: asSqlite, and consume: 'if-any' for incremental migrations ([`41d7df8`](https://github.com/petarzarkov/dunx/commit/41d7df86f463ead90e9e636fde28d29d2b0e71fe))
- **bench**: ASP.NET Core minimal API and MVC subjects ([`5813773`](https://github.com/petarzarkov/dunx/commit/5813773c6d9716b39aa13b01e5f7de02c7bc649f))
- **docs**: motion for the documentation chrome ([`4408528`](https://github.com/petarzarkov/dunx/commit/4408528752cf2a9c3fd8cfe0ecb566bcde8da6e6))

### Fixes

- **http**: return IPv4-mapped client addresses in their IPv4 form ([`3b15806`](https://github.com/petarzarkov/dunx/commit/3b15806564042918d9881c02e9a28a708bcdf118))
- **http,openapi**: let the client and OpenApi forRootAsync take imports ([`148c24d`](https://github.com/petarzarkov/dunx/commit/148c24d06d0f02dc0a0fd122af291e7fcbe7fd6b))
- **infra**: let ScheduleModule and RedisModule forRootAsync take imports ([`d1553e5`](https://github.com/petarzarkov/dunx/commit/d1553e5fa8c5d3f7ecb9552609a1866207f737ae))
- **infra**: name a thrown non-Error in a schedule's lastError ([`f68da45`](https://github.com/petarzarkov/dunx/commit/f68da45aaf0dc87c248fe4dee27210e3916f6d9b))
- **openapi**: keep the sorter shorthands offered, and pass raw source through as source ([`a9ea444`](https://github.com/petarzarkov/dunx/commit/a9ea44436fd1967c0e8e41332ec8cee3c8f98f6c))
- **scripts**: keep calling a heading-delimited target a section ([`f9e7e87`](https://github.com/petarzarkov/dunx/commit/f9e7e87969c9491434d5d1e1972644c63dc5ec44))

### Performance

- **docs**: unmount after every test, cutting the suite from 16.6s to 3.7s ([`c3586b3`](https://github.com/petarzarkov/dunx/commit/c3586b3cdb55c79bf3ebff78820f43637b030fd6))

### Refactors

- stop exporting 23 symbols nothing outside their file uses ([`fdeae59`](https://github.com/petarzarkov/dunx/commit/fdeae59a06c2d3a5adac0a0aaf4f78c621aa06e4))
- **http**: use AsyncModuleConfig instead of restating it inline ([`364eaba`](https://github.com/petarzarkov/dunx/commit/364eaba90bee49eefb7a69fa338eb470f61aa546))
- one source for the positioning, read by both the README and the hero ([`bd2ecda`](https://github.com/petarzarkov/dunx/commit/bd2ecdaf3a67381e6a5565bb28f29f3c80313a6d))

### Documentation

- corrections from a NestJS migration's field notes ([`088fcc3`](https://github.com/petarzarkov/dunx/commit/088fcc3caaf68e7bed070e32dc8ccd708ad385c7))
- trim CLAUDE.md back to rules, with the rationale linked once ([`0433b22`](https://github.com/petarzarkov/dunx/commit/0433b2266fa6b12ecc92639b3b30b43156b8cf26))
- **architecture**: tools/* is published, internal/* is the private half ([`17a9d99`](https://github.com/petarzarkov/dunx/commit/17a9d993cce7e5e79ab5822924001eb2251dda05))
- correct what coverage counts that no test can reach ([`695d3ca`](https://github.com/petarzarkov/dunx/commit/695d3ca08fc427d0586f2e0ac3f12f38d3210da0))
- link the Firecracker deployment ([`6cccbe8`](https://github.com/petarzarkov/dunx/commit/6cccbe87f5cdc7bc27a3dd0cae4b3291f4f1dd26))
- showcase Firecracker, and cut two lines that describe the document ([`cf981bc`](https://github.com/petarzarkov/dunx/commit/cf981bc6d6e8b1f3612e1f06a64d4ebd6e669e8c))

### Other changes

- **bench**: bump the two Go deps Dependabot flagged ([`95c5acb`](https://github.com/petarzarkov/dunx/commit/95c5acb58cfc007bc224fdbaa7dad1deb6caeaec))
- stop uploading the screenshots ([`1367ae2`](https://github.com/petarzarkov/dunx/commit/1367ae247ddecff2202897ce8f40155e3b364bdf))
- **docs**: check that every @dunx import in a guide really exists ([`16b11bd`](https://github.com/petarzarkov/dunx/commit/16b11bd8d89d1f465abfd4a492b7b336afea909c))
- **lint**: raise max-lines to 800 for test files ([`53e1cbe`](https://github.com/petarzarkov/dunx/commit/53e1cbe718cd13a3c74dd0f9a9f935d5ecb65f0e))
- drop six dependencies nothing imports ([`24413ad`](https://github.com/petarzarkov/dunx/commit/24413ad230097acf418f66ede58b463a26235c86))
- **infra**: cover JobProcessor, the child half of a sandboxed worker ([`2e28c50`](https://github.com/petarzarkov/dunx/commit/2e28c5097d6b687605e4ade73f058a1b26428d79))
- **infra**: run the S3 suite against MinIO, and declare services in one job ([`3267959`](https://github.com/petarzarkov/dunx/commit/3267959bb7ea1bddfa46ec2aa3ff49d1e58592a1))
- take the coverage model from the coverage job instead of rebuilding it ([`2d46edd`](https://github.com/petarzarkov/dunx/commit/2d46edd0ba81d04a69c86d209f912780fbbde085))
- raise the infra and openapi floors, and show the coverage number on success ([`0d0de97`](https://github.com/petarzarkov/dunx/commit/0d0de975a17492804043e6fdcf5cfe9982a01af4))
- give the test jobs a valkey service, and upload the dot-prefixed screenshots ([`10a1863`](https://github.com/petarzarkov/dunx/commit/10a186302cb9c38488834f4fe01bc585b1d1e66f))
- run every gate through one command, and fail on the first new lint warning ([`9440ab9`](https://github.com/petarzarkov/dunx/commit/9440ab907966bf302fb0ca13314dda89bd62afeb))
- gate every published workspace at 90% coverage ([`1743282`](https://github.com/petarzarkov/dunx/commit/17432822c37955e4330c225d676aa7fb34b1a9ba))
- **docs**: drive the built site with Bun.WebView instead of playwright ([`3c2a149`](https://github.com/petarzarkov/dunx/commit/3c2a14985d1e3090e0ed1adbbdf9aef91218da41))

## 3.0.1 - 2026-08-23

Drop the deprecated re-exports and fix what the screenshots showed

`@dunx/http` no longer re-exports the 56 plumbing symbols that moved to
`@dunx/http/internal` in 3.0.0. Those re-exports carried a `@deprecated` tag
promising removal in 4.0; the package has no consumers to give a window to, so
that notice is superseded rather than honoured, and the removal lands here.

A patch rather than a major because the version is a statement about what
happened to users, and nothing happened to any. The commit that removes them is
marked breaking, so the API record stays accurate either way. The supported
surface is 133 exports on the barrel and 13 on `./client`, unchanged from 3.0.0;
`surface.test.ts` freezes both.

The documentation site gained a screenshot script and six fixes it found.

The hero sold the pitch the README stopped selling in 3.0.0: "Enterprise
structure. Bun-native speed." over a throughput panel, before a reader knew what
dunx was. It now leads with what the packages bundle, and speed moved down to
sit with the benchmark summary.

Prose ran at four different line lengths - 95, 107, 133 and 139 characters -
because the reading measure the theme had a variable for was never set. It reads
at 74 everywhere, and code blocks and tables still take the full column.

A short page left the footer floating with 525px of dead space under it. On a
phone the install command read `bun add @dunx/core @dunx/http @du`, scrollable
with the scrollbar hidden, which looks the same as broken. Two sidebar entries
sat unlabelled above the first section heading. The link to a guide's source was
dimmed to caption grey with nothing to say it was clickable. Inline code carried
a border that turned a sentence naming seven symbols into a ransom note.

### Breaking changes

- **http**: remove the deprecated re-exports ([`05139dc`](https://github.com/petarzarkov/dunx/commit/05139dcfd1a47cabc82d70245af736b708b604fb))

### Fixes

- **docs**: screenshot the site, then fix what it showed ([`6bc2502`](https://github.com/petarzarkov/dunx/commit/6bc25029a8111c0121d8b393ca5271a47295d483))

## 3.0.0 - 2026-08-23

a smaller public surface, five transform fixes, and documentation that stops repeating itself

This release acts on an external review of the repository. Nothing in it is
source breaking: every symbol that moved is still exported from where it was,
and the container fixes turn failures into successes rather than the reverse.
The major is deliberate, because the shape of the public API changed and a
deprecation clock now runs against it.

**Five defects in `@dunx/transform`, each reproduced with a failing test before
it was fixed.** Four of them broke the promise that a type which erases is a
boot error naming the parameter rather than a silent `undefined`:

- `import type Foo from './foo.js'` and `import type * as NS from './ns.js'`
  were never collected, because only named specifiers were read. Their names
  were emitted bare into the dependency thunk, so resolution threw a raw
  `ReferenceError` instead of the boot error.
- A qualified name was sliced whole and looked up against a map keyed on bare
  names, so `ns.Thing` never matched. Only the leftmost identifier has to exist
  at runtime, and that is what is checked now: a value namespace import still
  emits `ns.Thing`, and a type-only one is unresolved naming `ns`.
- A local `interface Logger` poisoned a `class Logger` it merged with in the
  same file. Top level class declarations are subtracted from the erasure map,
  classes only, since `const X` beside `interface X` really is erased.
- A constructor parameter with a default failed boot, so
  `constructor(retries = 3)` could not be built at all. It is recorded as
  optional now and the container passes `undefined`, letting the default stand.
  A rest parameter is still an error, and a test says that is deliberate.

The fifth was a false claim rather than a crash. `edits.ts` said splicing
preserved the line numbers stack traces point at, and it did not: three lines
were inserted per annotated class, so a throw in the third class of a file
reported six lines low. The dependency record is emitted on the class's own
closing brace line, so the line count is unchanged, and a test asserts it.

**`@dunx/http` had grown to 173 barrel exports**, every one a semver promise, and
about a third were the framework's own plumbing: route table construction, the
middleware fold, the relay codec, the discovery readers, and the retry and JSON
helpers behind the client. Those 56 symbols move to a new `@dunx/http/internal`
subpath, which carries no stability promise.

The barrel and `./client` still re-export all of them under a `@deprecated` block
naming the replacement, so no import breaks on this release. They are removed in
4.0. The supported surface is 133 on the barrel and 13 on `./client`, and
`surface.test.ts` freezes both lists so an addition shows up in a diff.

**Comments are now gated the way prose already was.** `packages/` and `tools/`
measured 31.5% comment lines, and the densest were design memos in JSDoc costume.
Length rather than density turned out to be what separates those from a comment
that earns its place: the median block was four lines, while 131 blocks over
twelve lines held 2,437 lines between them, 30% of every comment in 8% of the
blocks. All 131 are gone. A flat density budget was rejected because the
documentation site builds its API reference out of the same doc comments, so it
would have charged a package for documenting itself.

**Documentation stops saying the same thing twice.** The package READMEs went
from 3,204 lines to 790, none over 100: what it is, install, one worked example,
and a table linking the guide chapter that owns each area. The guide is canonical
and each table says so. `docs/research/` and `docs/roadmap/`, 14 files of
measurement records and planning notes, moved to `internal/notes/` and out of the
tree a new reader browses; `docs/ROADMAP.md` stayed, since it is the public
summary the README links.

**The README leads with what dunx bundles.** It sold Nest style dependency
injection at Bun speed, which is not why anyone would switch. What is unusual is
that controllers, validation, OpenAPI, WebSockets with a Redis relay, bullmq,
drizzle over both `bun:sqlite` and `Bun.SQL`, S3, images, scheduling, health
checks, throttling, compression, an HTTP client, better-auth, a test harness, an
ops dashboard, a scaffolder and an MCP server ship together under one version
number. Dependency injection moved to fourth, and the benchmark table from
headline to reassurance.

Smaller corrections: the README badge claimed Bun 1.3 while every `engines` field
required 1.4, and CLAUDE.md numbered its rules 1, 3, 2, 4.

### Fixes

- **transform**: five defects in constructor dependency recording ([`55d2b4b`](https://github.com/petarzarkov/dunx/commit/55d2b4b365a2072db158208ba3eb82c0daa2ecb5))

### Refactors

- **http**: move the framework's own plumbing behind ./internal ([`f677dc8`](https://github.com/petarzarkov/dunx/commit/f677dc8b59438c3cd4b456d796fcfaceb25c904a))
- cut the design memos out of source comments ([`e261461`](https://github.com/petarzarkov/dunx/commit/e261461df01e5668ca3bde69b99db6ab3157f8fe))

### Documentation

- lead the README with what dunx bundles, not with DI ([`6e8287a`](https://github.com/petarzarkov/dunx/commit/6e8287a09aec6ff83260c30b2ee795efcb99a5bc))
- cut the package READMEs to a page each ([`34f5824`](https://github.com/petarzarkov/dunx/commit/34f5824191ad871ffd2fe86f151edf5c15c9d3e5))
- correct the Bun badge and the rule ordering ([`33b3d92`](https://github.com/petarzarkov/dunx/commit/33b3d92ffce128049ffe234e444e2d51e112ec64))
- move the working notes out of the user-facing tree ([`101cd0b`](https://github.com/petarzarkov/dunx/commit/101cd0b088fb24010929ac27be9b86b9e62b3468))

### Other changes

- **scripts**: gate source comments on block length, not density ([`67c28b8`](https://github.com/petarzarkov/dunx/commit/67c28b82248a915cdc037de4cf4e099c7b40ced8))

## 2.5.0 - 2026-08-22

response compression, W3C trace context, and compile-time response shapes

Three additions to `@dunx/http`, none of them on by default, and one of
them a type-level check that costs nothing at runtime.

**Response compression.** `Bun.serve` does no content encoding at all, so
`@dunx/http` had no answer for it. `Compression` is a middleware the app
registers itself with `app.use(Compression)`, so an app that does not want
it has no branch in the request path to skip. It picks the sync encoder for
a body it can buffer and `CompressionStream` for one it cannot, which is
what lets a small response carry an accurate `content-length` while an SSE
feed still streams. `zstd` and `gzip` are offered and negotiated by
q-value; `vary`, weak `ETag`s, `no-transform`, 204/205/304 and 206 are all
handled the way the RFCs ask.

Two codings were measured and refused. Brotli encodes a 6.4 KB body in
6,344 us against gzip's 23, and the `level` that would fix that is accepted
and ignored. `deflate` is worse: `Bun.deflateSync` emits raw DEFLATE where
`CompressionStream('deflate')` emits zlib, which is what the header means,
so offering it would have flipped wire format at the buffering threshold.
Both are recorded in docs/bun-apis.md.

**W3C Trace Context.** `requestId` already spans two dunx services but
cannot span one that is not dunx. `requestLogging: { trace: true }` adopts
an inbound `traceparent`, puts `traceId`, `spanId` and `parentSpanId` on
every line the request writes, and `@dunx/http/client` forwards the trace
to whatever the app calls. One header parsed and one written: no exporter,
no sampler, no collector, no dependency. Off by default, at 360 ns per
request when on.

Not an OpenTelemetry integration, and that was measured too. Bun 1.4's OTel
support patches `node:http` through `require` only, and produces no spans
for `Bun.serve` or `fetch`, so an SDK here would be 73 packages watching
none of the traffic.

**Response shapes, checked at compile time.** The verb decorators now hold
a handler's return type against its own `response` entry for the success
status, so a handler answering with a shape the document does not describe
is a compile error in the controller rather than a surprise for whoever
read the document. It found one already: `User` documented a `tags` array
the table has no column for. Nothing is validated at runtime, so the
request path is unchanged.

**Two changes are breaking, despite the minor bump.** `@dunx/infra`'s root
barrel no longer re-exports `/db`, because `export *` put a static
`drizzle-orm` import in the root chunk graph and made an optional peer a
hard requirement of `import '@dunx/infra'` for every consumer. Import those
symbols from `@dunx/infra/db`, which was already the used path. And
`engines.bun` is now `>=1.4.0` across every package: compression needs
`Bun.zstdCompressSync` and `Bun.cron` only honours `{ tz }` from 1.4.

Packages also stopped shipping source maps. `sourcemap: 'linked'` embedded
full `sourcesContent`, so each one published its own TypeScript inside the
`.map` and the maps were 50-64% of the tarball by byte.

Also in this release: `bun run --parallel` for the multi-workspace scripts,
so `test` and `typecheck` prefix every line with its package; and a
recorded spike showing `Bun.WebView` drives the dashboard headlessly on
Linux with no display and no dependency, which is the browser assertion
happy-dom structurally cannot make.

### Breaking changes

- **infra**: keep /db out of the root barrel, so drizzle-orm stays optional ([`ee0b929`](https://github.com/petarzarkov/dunx/commit/ee0b92932d8b72dcd067712c76ced22ff7ac4fbd))

### Features

- **validation**: enforce response shape checks at compile time across routes ([`4cbac38`](https://github.com/petarzarkov/dunx/commit/4cbac382e67ec295aff43ea78cb4e750392ce55a))
- **http**: W3C Trace Context, adopted inbound and forwarded outbound ([`e8e3146`](https://github.com/petarzarkov/dunx/commit/e8e3146275ec37e2cc2c442f352529f1ac20e65e))
- **http**: opt-in response compression on Bun's own compressors ([`11ae3f2`](https://github.com/petarzarkov/dunx/commit/11ae3f2b79137a7402d13f2b34937c45162e53ea))

### Fixes

- **http**: withdraw the deflate coding before it ships ([`12ceaf9`](https://github.com/petarzarkov/dunx/commit/12ceaf9c521f5eb7415e6b07e6ef7dab7ca02dfa))

### Documentation

- **openapi**: swagger-ui-dist is a dependency, not an optional peer ([`f5ac14e`](https://github.com/petarzarkov/dunx/commit/f5ac14ef751e435da9249c5cc86fc5ccc4e9e25e))
- **architecture**: Bun.WebView drives the dashboard headlessly, measured ([`8c84686`](https://github.com/petarzarkov/dunx/commit/8c8468691e7512e13d737d7366e9b7d1c114f9cc))

### Other changes

- require Bun >= 1.4.0 ([`2d8c6b4`](https://github.com/petarzarkov/dunx/commit/2d8c6b41bf1466a1cf83f7a08700a6828d88ca28))
- stop shipping source maps ([`0f81d4b`](https://github.com/petarzarkov/dunx/commit/0f81d4b7dbc5824937cbbf15f7b15d6062801e36))
- **create-app**: re-sync the vendored users template ([`a60667f`](https://github.com/petarzarkov/dunx/commit/a60667f2760077d510476187a8183a0ffd42daa2))
- run multi-workspace scripts with bun run --parallel ([`4d877e8`](https://github.com/petarzarkov/dunx/commit/4d877e8f24860647de8fb52393781e5dd5c057be))

## 2.4.0 - 2026-08-22

bun --watch works, health probes documented, schemas named

### bun --watch and bun --hot restart on any source change

`@dunx/transform`'s plugin read source with `Bun.file`, which loads it behind Bun's
back, so every file the plugin handled dropped out of Bun's watch list. Since the
plugin handles every `.ts`, `bun run dev` restarted only on a change to the
entrypoint, in every dunx app. The plugin now reads through Bun's own loader:

    await import(`${path}?`, { with: { type: 'text' } })

The `?` is required, or the specifier still ends in `.ts` and re-enters the plugin.

The transform was never the cause: a plugin returning the source byte for byte broke
the watcher identically. Three other repairs are unavailable, and all three were
measured before this one was found. A runtime `onLoad` may not decline (returning
`undefined` is a `TypeError`), `watchFiles` on the result is accepted and ignored,
and `filter` is a path regex that cannot skip a file whose contents decide.

Free: `examples/full` boots in 353 to 365 ms reading through `import` against 354 to
374 ms with `Bun.file`, at 135 MB RSS either way. `watch.test.ts` guards it by
spawning a real watch and editing a real import, and fails if the read regresses.
Found via oven-sh/bun#4689.

### Every hoisted schema carries a title

A `components/schemas` entry now gets a `title` equal to its own key, unless it
declares one. Swagger UI labels a model `title || displayName || name`, and a `$ref`
reached through `items` supplies neither fallback, so `array&lt;User>` rendered as
`array&lt;object>` while the same `User` at the root of a response read as `User`.
Contributed schemas are titled too, so better-auth's `Session` reads like a
generated `User`.

This does not undo the refactor below it. That one moved _prose_ out of `title`,
because a sentence there is what a reader sees instead of the type name. The title
added here is the name, identical to the component key, so the Schemas list reads as
type names either way and `description` still holds the prose.

### response takes a plain JSON Schema

`RouteSchemas.response` accepts a JSON Schema object as well as a Standard Schema,
because a JSON Schema needs no conversion. `$id` hoists it into `components/schemas`
and leaves a `$ref`; without one it is inlined. Documenting a response no longer
costs a validator dependency.

Responses only. `body`, `query` and `params` are parsed, so they still need a
validator.

`JsonSchema` moved to `@dunx/http`, which is the lowest common owner now that
`RouteSchemas` names it. `@dunx/openapi` re-exports it, so no import changes.

### Health probes are in the document

`/health/live` and `/health/ready` appear under a `Health` tag, with the report as
`components/schemas/HealthReport` on both the 200 and the 503.
`HealthModule.forRoot({ documented: false })` mounts `HiddenHealthController`
instead: the same two routes, served and undocumented.

`HEALTH_REPORT_SCHEMA` is exported, so an app answering on its own paths can
reference the same definition. It restates the `HealthReport` interfaces, and
`health.test.ts` compares it against a report the registry produced so the two
cannot drift.

### Swagger UI options

`OpenApiModule`'s `ui` takes every Swagger UI parameter, typed, with `RawJs` for the
seven that are functions and therefore cannot cross from a server-rendered page as
values.

`swagger-ui-dist` is a `dependency` of `@dunx/openapi` rather than an optional peer,
so it installs without being named. It costs 12 MB in every install of the package,
including one that only serves `openapi.json`.

### Request bodies in the request log

`requestLogging: { requestBody: true }` includes the body. On a route that declares a
body schema the reader is buffering it anyway, so this costs 1.87 us; on a route with
no schema it reads the raw text rather than cloning the request, at 28.81 us.

### Examples, and Rule 4

`examples/full` uses `HealthModule` rather than a hand-rolled controller, with its
indicators declared once and read by both the probes and the dashboard's `probes`
panel.

Four features had shipped with no example, and now have one: `ThrottleModule`
(2.2.0), `ScheduleModule` and `StaticModule` (2.1.0), and `@dunx/http/client`.
All four are scaffoldable, taking `bunx @dunx/create-app` from 13 features to 17.

CLAUDE.md gained Rule 4: a feature is not shipped until an example uses it. Writing
these examples found a Bun parse bug that every scheduled service would have hit,
recorded in `docs/bun-apis.md`: a class with a decorated member cannot contain a
read-modify-write on a private field, so `#count += 1` next to a `@Cron` is a
`SyntaxError` naming neither.

Worker logs also keep their colour across the sandbox fork, which bullmq gives a
piped stdout.

### Upgrading

Two things change generated output, so re-record any golden-file test of your
OpenAPI document:

- every `components/schemas` entry gains a `title`
- `/health/live` and `/health/ready` are documented unless you pass
  `documented: false`

### Refactors

- update schema metadata to use 'description' instead of 'title' ([`d44bd14`](https://github.com/petarzarkov/dunx/commit/d44bd146a7df43a215f668ed1edc8ada1bcfc742))

## 2.3.1 - 2026-08-22

enhance Swagger UI integration by adding favicon and improving asset handling

## 2.3.0 - 2026-08-22

remove inlined OpenAPI explorer and integrate swagger-ui-dist

- Deleted the inlined OpenAPI explorer from `packages/openapi/src/ui.ts`.
- Updated `tools/create-app/src/features.ts` to include `swagger-ui-dist` as a dependency for the OpenAPI feature.
- Modified `tools/create-app/src/generate.ts` to add `swagger-ui-dist` to the third-party dependencies.
- Adjusted `tools/create-app/templates/features/docs/docs.demo.ts` to log requests for assets served from `swagger-ui-dist`.
- Created a new `docs/roadmap/bun-1.4-adoption.md` to document the impact of upgrading to Bun 1.4.
- Added a new FastAPI example in `internal/bench/servers/python/fastapi_app.py` for benchmarking.
- Introduced `packages/openapi/src/swagger.ts` to handle the resolution and serving of Swagger UI assets.
- new benchmarks measured on bun 1.4

## 2.2.1 - 2026-08-21

### Features

- **http**: warn when socket middleware silences error reporting ([`835c74d`](https://github.com/petarzarkov/dunx/commit/835c74d308c40504ef768b6c7cf92524eed22e31))

### Fixes

- **http**: put the request id on a mapped failure ([`e8c40e1`](https://github.com/petarzarkov/dunx/commit/e8c40e1da098834019b19ea0a6c9cb770d5dd2a9))
- **health**: take uptime from a monotonic clock ([`a2c285b`](https://github.com/petarzarkov/dunx/commit/a2c285b058d675e06d600b607df0194290a8a359))
- **release**: stop the pipeline deadlocking on its own generated commit ([`a984d34`](https://github.com/petarzarkov/dunx/commit/a984d34e7e8c2d526699c2890accde7031f8b26a))

### Documentation

- split the preflight paragraph under the prose budget ([`3d01f05`](https://github.com/petarzarkov/dunx/commit/3d01f050415c6bda5a315ba7eb7d00101c78977b))
- correct two claims the code does not make ([`0f2ab40`](https://github.com/petarzarkov/dunx/commit/0f2ab4028f64d7457a1f53909c0e37c18e6ec051))

## 2.2.0 - 2026-08-20

a throttle, websocket middleware, sync paginate, and a teardown that finishes

Re-triggers the 2.2.0 release, and fixes the reason it did not happen the first time.

Merging the release pull request produced a green CI run that published nothing.
getReleaseTrigger reads HEAD's subject, and GitHub had made HEAD a merge commit
whose subject is 'Merge pull request #3 from ...' - the release(minor) line it was
looking for was on the first line of the _body_, where the parser deliberately does
not look. A release pull request could therefore never release, and the only symptom
was a successful run and an unchanged npm.

mergeSubject reads that one line, and only when the commit really has two parents.
The subject-only rule is otherwise untouched, which is the point: a body is where a
revert or a changelog paste puts the word, so scanning it generally would publish by
accident. It takes the parent count as an argument rather than shelling out, so it is
a pure function the tests drive without a repository to merge in.

The five items 2.2.0 carries are described on d6b6b19 and in the changelog it
generates.

Co-Authored-By: Claude Opus 5 (1M context) &lt;noreply@anthropic.com>

### Fixes

- **release**: put the release commit's body in the changelog ([`dd9b0b1`](https://github.com/petarzarkov/dunx/commit/dd9b0b1dd2989e458f59842ef51bc63895b2185c))

### Documentation

- rewrite the guides against the 2.1.1 source ([`55c3674`](https://github.com/petarzarkov/dunx/commit/55c3674e6ce250e38bff17d86e30b9511ff7dcae))
- **changelog**: update changelog for 2.1.1 release, rename OnDrain to OnBeforeShutdown ([`63ac16c`](https://github.com/petarzarkov/dunx/commit/63ac16ce1e94e1176c06876a86a8cfca602e8f40))

## 2.1.1 - 2026-08-19

rename the drain hook, and document what 2.1.0 shipped

**`OnDrain` is `OnBeforeShutdown`.** The name was already taken. `@dunx/http` has
exported `@OnDrain()` as a **websocket handler** decorator since long before this
lifecycle phase existed, where it means "backpressure relieved, safe to resume
sending". Shipping a second, unrelated `OnDrain` in `@dunx/core` left one framework
with two of them, and `import { OnDrain } from '@dunx/http'` gets the decorator, so
`implements OnDrain` from that import is a confusing error rather than a hint.

The newer name moves, being hours old against a decorator that is not. Everything
else keeps the word, since none of it collides: `App.drain()`, `drainDelayMs`,
`Readiness.draining`. The interface, its method and its guard are what changed.

It also lines up with what it replaces. Nest's `beforeApplicationShutdown` runs
before `onApplicationShutdown`, which is this split exactly, and the migration table
in the lifecycle guide now says so rather than mapping it onto `OnShutdown`.

Technically breaking, released as a patch. 2.1.0 is hours old, the phase it renames
was new in it, and a major for a name correction is worse churn than the correction.

**A GitHub release is created again.** 2.1.0 produced a `v2.1.0` tag and no release:
Actions does not put `GITHUB_TOKEN` in the environment on its own and the release
step's `env:` named only `FORCE_PUBLISH`. The tag hid it, because the tag push falls
back to the credential `actions/checkout` persists, so half the feature worked. The
skip is now loud under `GITHUB_ACTIONS` and quiet locally, since reporting both the
same mild way is what let it through.

**The guide covers what 2.1.0 added.** Scheduling and health checks were documented
in their package READMEs and nowhere in the tour, so a reader following it never
learned they exist. Two new pages, and the lifecycle guide gains the shutdown phase
it was missing.

That needed renumbering rather than appending: sections are ordered by the numeric
prefix, and appending split Infrastructure around Going live, which
`site.test.tsx` catches as non-contiguous. Scheduling is 16 and health checks is 20,
so authentication, files-and-images, deployment and agent-tooling shift up one.
Slugs strip the prefix, so no URL changes.

## 2.1.0 - 2026-08-19

health checks, a Bun.cron scheduler, and graceful draining

### Features

- **http**: health checks, and the drain that makes readiness mean something ([`977d550`](https://github.com/petarzarkov/dunx/commit/977d550ec63a1ec7979cee2dc297714ef91df3fe))
- **infra**: SchedulerModule on Bun.cron behind @dunx/infra/schedule ([`3b07ac3`](https://github.com/petarzarkov/dunx/commit/3b07ac3cbf4410ab9a4f01fc30fe5327dd0123c3))
- **formatting**: enhance pre-push hook to enforce code formatting and prevent unformatted files from reaching CI ([`3e0d25f`](https://github.com/petarzarkov/dunx/commit/3e0d25f8f470ef658afffc458ded578a2360cd65))
- **core**: name the runtime in the boot entry ([`fbb069e`](https://github.com/petarzarkov/dunx/commit/fbb069e0206ea348d6d854fe2a9e7cf88cae37db))
- **release**: tag each release and create the GitHub release ([`e82c2e1`](https://github.com/petarzarkov/dunx/commit/e82c2e106f7c1f24ef37d1f9e8c24ef1856e85bf))
- **docs**: a page per release at #/releases/&lt;version> ([`b9461f5`](https://github.com/petarzarkov/dunx/commit/b9461f521c726358d977eec42a869638d23e7c01))
- **core**: add the OnDrain lifecycle phase ([`8ea2bf1`](https://github.com/petarzarkov/dunx/commit/8ea2bf108f2d390c0174eb972ee75b2cf749f9ce))
- add Releases page to display package versions and release notes ([`1508f7e`](https://github.com/petarzarkov/dunx/commit/1508f7e75f59ac3f3e70c8177d702401c38d0328))

### Fixes

- **docs**: give the suite a timeout its own tests can meet ([`57bea24`](https://github.com/petarzarkov/dunx/commit/57bea2499eae22da747b6823867147c474f2133b))
- **schedule,docs**: review follow-ups, and a flaky chart test ([`b1eb147`](https://github.com/petarzarkov/dunx/commit/b1eb147411935949325674e33a425f96b54e2af3))
- **infra**: take @arkv/logger 0.10.2 for the typed-array stall ([`7d71007`](https://github.com/petarzarkov/dunx/commit/7d71007ef2fc8699220130d9821ae5b3e9da53aa))
- **infra**: take @arkv/logger 0.10.1 for the context contract ([`9e48887`](https://github.com/petarzarkov/dunx/commit/9e488874653f852665a1677ecbcaff60ccb398a7))
- **mcp**: answer malformed JSON-RPC instead of dropping it ([`8ce31a5`](https://github.com/petarzarkov/dunx/commit/8ce31a50e2caf9edaa9849fdb908a8480e9de64a))
- **http**: count X-Forwarded-For hops from the right ([`1a4c03d`](https://github.com/petarzarkov/dunx/commit/1a4c03d766dbca8b5be616ec3377e0238c71608c))
- **logo**: rotate the mark 90 degrees so it reads as the d ([`64c155e`](https://github.com/petarzarkov/dunx/commit/64c155e644c70e835c6e85359727f98a93bc6e42))
- update page title for clarity and branding consistency ([`6d95c70`](https://github.com/petarzarkov/dunx/commit/6d95c703d635d82afdcd2bc5ca2637a0af4ebdac))

### Performance

- **core**: spread the request context once, not twice ([`b3a6cd2`](https://github.com/petarzarkov/dunx/commit/b3a6cd270ca7fbc68b0f36016376dc6e410fd63f))

### Refactors

- **docs**: improve formatting and clarity in release notes, RPC, scheduler, and throttle documentation ([`1091b13`](https://github.com/petarzarkov/dunx/commit/1091b1339cee64357c385997f1797099c1e3357a))
- one prototype walker for every marked method ([`1dbfe9e`](https://github.com/petarzarkov/dunx/commit/1dbfe9ef85b6791df7f59194849ae215e2f01969))
- **docs**: update references to package paths, improve clarity, and enhance structure ([`81f1ce9`](https://github.com/petarzarkov/dunx/commit/81f1ce94482e6f4fbe39a0dfafac104940247448))
- improve documentation clarity and enforce voice rules ([`6022cc5`](https://github.com/petarzarkov/dunx/commit/6022cc53861e6f289a0ca707ba3f454d1fb1a3be))

### Documentation

- **research**: the serialization record, and two defects it turned up ([`64e4e16`](https://github.com/petarzarkov/dunx/commit/64e4e1626ea6f2062402876c713643df28d7b16b))
- **research**: defect 3 is a documented decision, not a defect ([`544429f`](https://github.com/petarzarkov/dunx/commit/544429f4adf9cd584cdacdeb3e0be738f6c10033))
- **research**: add the stats record and a fourth Rule 2 move ([`3333ed5`](https://github.com/petarzarkov/dunx/commit/3333ed50b920e1003f775445d7ad2d267b802093))
- research ([`34e0f73`](https://github.com/petarzarkov/dunx/commit/34e0f735032321d3b8ea707d4679b6f619e0910b))

### Other changes

- Add Ko-fi username to FUNDING.yml ([`d4c1bfa`](https://github.com/petarzarkov/dunx/commit/d4c1bfaa4aed6f3d829da6bec73735a596bbe13f))
- Refactor roadmap documentation and remove obsolete files ([`a7d12ca`](https://github.com/petarzarkov/dunx/commit/a7d12cac3a35e68bed064ecdf3ae9acdab6917b8))

## 2.0.1 - 2026-08-14

infra fix NotThenable constraint and move to the return type as NoPromise&lt;T>

## 2.0.0 - 2026-08-10

enableShutdownHooks ends the process, it does not only drain

## 1.3.0 - 2026-08-10

gate publishing behind a release commit, and stop queue workers spinning

### Features

- **queue**: implement background job processing with sandboxed workers ([`fe14c1b`](https://github.com/petarzarkov/dunx/commit/fe14c1bc1132388bf24f04a11f1ffd8ffc92df68))
- add INLINE_WORKER support to consume queues in the web process with unified logging ([`c45d42c`](https://github.com/petarzarkov/dunx/commit/c45d42cf29115d75cee0394445a98763ca676249))

## 1.2.1 - 2026-08-08

### Features

- enhance OpenAPI UI with favicon support and improve static file handling ([`aa5139f`](https://github.com/petarzarkov/dunx/commit/aa5139f3471db2505cc3c84379f620cf48f445e8))

### Fixes

- resolve getWorkers() issue by forwarding connection name in duplicate wrapper ([`e653e95`](https://github.com/petarzarkov/dunx/commit/e653e95a9b18ce140206b949977a2aa6f0f46003))

### Refactors

- update package path handling in coverage report and improve test coverage ([`2e48efe`](https://github.com/petarzarkov/dunx/commit/2e48efe6312c80dc9bb6ca82b27207e609feae8c))

## 1.2.0 - 2026-08-06

### Features

- **restructure**: re organize project ([`f0b67c5`](https://github.com/petarzarkov/dunx/commit/f0b67c5420885eb4ae5ee017adf244926ef10fba))

## 1.1.0 - 2026-08-06

### Features

- **logging**: enhance boot logging to include served routes and gateways; update logger dependency to 0.9.0 ([`ac58be7`](https://github.com/petarzarkov/dunx/commit/ac58be74193cd2b3c612d32c65ee188d7b53b435))

### Documentation

- update CLAUDE.md and ROADMAP.md for module-scoped DI changes; clarify middleware usage in http.md ([`f07045e`](https://github.com/petarzarkov/dunx/commit/f07045e266e36dd0ad42206e154b9deac2a6da98))

## 1.0.1 - 2026-08-05

### Refactors

- improve middleware and guards documentation for clarity and accuracy ([`d91a6dd`](https://github.com/petarzarkov/dunx/commit/d91a6dd72063736cdd1385e869d121410d3a3455))

### Other changes

- enhance ClientAddress test with detailed comments on instance behavior ([`f10a197`](https://github.com/petarzarkov/dunx/commit/f10a197767d13b8886745f5b6d1aaeea2ba6fc41))

## 1.0.0 - 2026-08-05

### Breaking changes

- module-scoped DI with exports, global modules and module middleware ([`22d1f4f`](https://github.com/petarzarkov/dunx/commit/22d1f4f8bb6566de7d331df9d5a50f8b59d7af81))
- **examples**: migrate examples/full to module scoping ([`15e85e3`](https://github.com/petarzarkov/dunx/commit/15e85e3202638e82367c034bf25326b9e1b349c9))
- **http**: resolve global middleware as the app's root sees it ([`943db7d`](https://github.com/petarzarkov/dunx/commit/943db7dd132fc9572f813ab430866a173189b9ac))
- exports sweep across every package, and two resolution fixes ([`a6f2ded`](https://github.com/petarzarkov/dunx/commit/a6f2dedf41f4dacbdea782bfb4cf5b7c7db454f0))
- **core**: a DI scope per module, with exports and global ([`ba9b294`](https://github.com/petarzarkov/dunx/commit/ba9b29487b42ee2c675e601d803bf1c8d7e5da94))

### Features

- **mcp**: report scope and visibility, not a flat graph ([`0e55ffe`](https://github.com/petarzarkov/dunx/commit/0e55ffe537096e4c99de39ff53023f9967665e7c))
- **http**: module-scoped middleware, which is what scoping was for ([`835299d`](https://github.com/petarzarkov/dunx/commit/835299d9ca8f7514698acdfdac81828ca1af12db))
- enhance error handling by introducing ErrorFilter class and updating HttpOptions.onError to accept class instances ([`3731b3f`](https://github.com/petarzarkov/dunx/commit/3731b3f2be7b98439a45c32e7f3f6b7452ec834c))

### Fixes

- **create-app**: two feature dependencies the flat container hid ([`18909b8`](https://github.com/petarzarkov/dunx/commit/18909b8282402ec90725bd9799f885ca19509b0d))

### Refactors

- remove @dunx/queue-dashboard from the generated model dependencies ([`ff407f8`](https://github.com/petarzarkov/dunx/commit/ff407f893c939fd1289f52bbdaa6d2233d2ef4de))
- remove @dunx/queue-dashboard and integrate dashboard functionality into dunx-dashboard ([`673c088`](https://github.com/petarzarkov/dunx/commit/673c08894d45b6e435e2bca35d1b95b966a1e7d8))

### Documentation

- measure the boot cost that was accepted sight unseen ([`5934b16`](https://github.com/petarzarkov/dunx/commit/5934b1612188401744b31713b3a45108c1854ebf))
- rewrite the DI architecture section for the scoped container ([`68ab77a`](https://github.com/petarzarkov/dunx/commit/68ab77a0a7c192667919ef4933398656efd0bc30))
- plan module-scoped DI as P0, and class modules as P1 ([`0c5f3e3`](https://github.com/petarzarkov/dunx/commit/0c5f3e3f31d5990a2c058428cb3c049ffa79f140))
- update roadmap for queue shutdown defects and add api surface consistency feedback ([`7777716`](https://github.com/petarzarkov/dunx/commit/777771666ee8c7bc65dac6b47714feebc2466757))

### Other changes

- delete queue dash ([`50e5349`](https://github.com/petarzarkov/dunx/commit/50e53498bb39cb2467a00f4728f917ad789e88eb))

## 0.9.0 - 2026-08-04

### Features

- enhance documentation and refactor MCP server structure ([`d6945ad`](https://github.com/petarzarkov/dunx/commit/d6945ade6d1e56649bc3f8b5705ebd822b379293))

## 0.8.0 - 2026-08-04

### Features

- refactor queue-dashboard to remove ejs dependency and implement substituteRenderer ([`1080ed7`](https://github.com/petarzarkov/dunx/commit/1080ed711e232a1ef738b1e20f36c98f4638f435))

## 0.7.1 - 2026-08-04

### Other changes

- update examples and create app templates ([`e93eb86`](https://github.com/petarzarkov/dunx/commit/e93eb8692c5ee2d0f5834b1e548d02492083a47e))

## 0.7.0 - 2026-08-04

### Features

- queue dashboard package and infra pagination ([`d7acc41`](https://github.com/petarzarkov/dunx/commit/d7acc41643be424aee6293e8e2066cbe2c9f5f59))

## 0.6.2 - 2026-08-04

### Other changes

- enable some eslint plugins ([`7bb39ef`](https://github.com/petarzarkov/dunx/commit/7bb39efdf4b6484f4553a9ea172543b62dfbc123))

## 0.6.1 - 2026-08-04

### Fixes

- endless loops ([`434c130`](https://github.com/petarzarkov/dunx/commit/434c13023f52415fb07f0a4f0f8b9c81e2ddf9b6))

## 0.6.0 - 2026-08-04

### Features

- http module client ([`2f20e36`](https://github.com/petarzarkov/dunx/commit/2f20e368b22e3b19219ba670817ab0d5a9da9064))

## 0.5.0 - 2026-08-04

### Features

- create app with templates and features ([`6eae745`](https://github.com/petarzarkov/dunx/commit/6eae745b03ca75ac51375572bf05b70a45a0f805))

## 0.4.0 - 2026-08-03

### Features

- actual working mcp, flaky test fix, and cli fix, core now owns Module ([`77c7e6f`](https://github.com/petarzarkov/dunx/commit/77c7e6faacbdf2be368e760718442d02ec061a7d))

### Other changes

- fix mantine default theme pick ([`5bdb8ea`](https://github.com/petarzarkov/dunx/commit/5bdb8eaebcfe0ee94b1732eef648f3e957100671))
- fix mantine charts ([`35ea016`](https://github.com/petarzarkov/dunx/commit/35ea01619464e669540e62bd0debc3386f8da88b))

## 0.3.1 - 2026-08-03

### Features

- **docs**: MIT licence, wider content, framed code blocks and an attributed footer ([`c5a138a`](https://github.com/petarzarkov/dunx/commit/c5a138afaf33813126c0819ce125dbc43ea0e4d0))

## 0.3.0 - 2026-08-03

### Features

- **mcp**: add @dunx/mcp, and publish a full 16-subject benchmark run ([`c5952a1`](https://github.com/petarzarkov/dunx/commit/c5952a1365663192977532f3be5c0b812225a854))
- **bench**: add Django, and measure the server rather than the framework ([`3b896c0`](https://github.com/petarzarkov/dunx/commit/3b896c08b0688f7ab09f6cf182f132f01b663288))

### Fixes

- **docs**: put ?h= back in the contents links ([`6a50fbf`](https://github.com/petarzarkov/dunx/commit/6a50fbf3b63e4adf07cb57fa373a576f050802a2))
- **infra**: listen for errors on the Queue, not only on its client ([`40f8ca4`](https://github.com/petarzarkov/dunx/commit/40f8ca4afa8c35ae7ac32895e7215a7cd6f8f25b))

### Documentation

- settle the MCP static-vs-boot question, and clear four finished roadmap items ([`353be0b`](https://github.com/petarzarkov/dunx/commit/353be0bba657c6161fe8593375d31976feae9d10))
- stop writing the framework's docs in its contributor's voice ([`2b604e6`](https://github.com/petarzarkov/dunx/commit/2b604e60d643bb8e48f4dbdf8e572b74ec2c06a7))

## 0.2.14 - 2026-08-02

### Fixes

- **docs**: point Get started at the introduction, and repair every broken link ([`9af89f9`](https://github.com/petarzarkov/dunx/commit/9af89f9efbbbf761665738c220a4a46185620483))

### Other changes

- **infra**: take @arkv/logger 0.8.2, and correct a wrong prediction ([`770898c`](https://github.com/petarzarkov/dunx/commit/770898ce97cfa17c84e7603281d53ea2b602846f))

## 0.2.13 - 2026-08-02

### Fixes

- **infra**: route queue connection errors to the Logger, not to stderr ([`7e4286b`](https://github.com/petarzarkov/dunx/commit/7e4286bcb4a89246d335e1b30f241f796a86694e))

### Documentation

- **roadmap**: the arkv proposals are implemented as arkv#4 ([`7c25d33`](https://github.com/petarzarkov/dunx/commit/7c25d3375134d403cd53fb2f7298ae179adbaeba))

### Other changes

- sync lockfile after merge ([`7c2e881`](https://github.com/petarzarkov/dunx/commit/7c2e8816ea8ad950dfc58b2a36f03dd0fb54915f))

## 0.2.12 - 2026-08-02

### Features

- **openapi**: ship an offline document generator as a bin ([`1fe2e5d`](https://github.com/petarzarkov/dunx/commit/1fe2e5dfdf590986caf6ad4d78a888907a61fe24))

### Documentation

- **roadmap**: record an MCP server for dunx as an open item ([`3bcb2a5`](https://github.com/petarzarkov/dunx/commit/3bcb2a5c20add60eb9fe8874a46924190d9c12e4))
- split the 2,689-line architecture record into twelve pages ([`19db658`](https://github.com/petarzarkov/dunx/commit/19db658660cfc6433a1981f74fd75ca85290e350))
- trace the lineage to Spring and Angular, not to NestJS ([`b7120d2`](https://github.com/petarzarkov/dunx/commit/b7120d2e1bb9bd63bf4ad51f77302bba7084f012))
- stop publishing absolute home paths ([`c132849`](https://github.com/petarzarkov/dunx/commit/c132849f98de87a9969ee7e947a22427382256f8))

## 0.2.11 - 2026-08-02

### Features

- **http**: add correlate opt-out, fix the page-ui flake and queue shutdown ([`9381f19`](https://github.com/petarzarkov/dunx/commit/9381f19d4881eb1331400b3c8a72bce6d5ea4b7f))
- **http**: make the not-found guard posture a choice, keeping the current default ([`8bc51c6`](https://github.com/petarzarkov/dunx/commit/8bc51c6b950829983c01a4c9630b9f81fd8e8992))

### Fixes

- **core**: say which module was configured twice, and document the union ([`1d871ab`](https://github.com/petarzarkov/dunx/commit/1d871ab7888080cf30d666663c58fd56ee3355fa))

### Other changes

- format after merge ([`ccff892`](https://github.com/petarzarkov/dunx/commit/ccff892751ad23a62038b08e34ec0c58be9e2246))
- correlate opt-out, page-ui flake, queue shutdown ([`76c68cf`](https://github.com/petarzarkov/dunx/commit/76c68cf9100f7b718e54215cf9a05598e6414fe5))

## 0.2.10 - 2026-08-02

### Features

- **http**: pass relayResubscribe through HttpOptions ([`790745e`](https://github.com/petarzarkov/dunx/commit/790745e8dc345468783cf1020afc0811fcf93a8c))

## 0.2.9 - 2026-08-02

### Features

- **bench**: add Gin, net/http, Axum and Spring Boot subjects ([`7d0131a`](https://github.com/petarzarkov/dunx/commit/7d0131ab4affca7ed9069824e3f073c6e6d73871))
- **http**: add @ApiHidden, and stop documenting the auth wildcard mount ([`744a1de`](https://github.com/petarzarkov/dunx/commit/744a1deab9ef46df63cd50dc0107b64e844235fc))

### Documentation

- tell consumers to keep every @dunx package on one version ([`e4250c1`](https://github.com/petarzarkov/dunx/commit/e4250c112276f2fb3d7610838fad716203f9910d))
- **auth**: point betterAuthDocument at forRootAsync, which already works ([`8aa6119`](https://github.com/petarzarkov/dunx/commit/8aa61199a9b204ddaa1b2c828391a30d1b60625c))

### Other changes

- cross-language benchmark subjects ([`badf612`](https://github.com/petarzarkov/dunx/commit/badf6125d698cb4968416afda52052e748288ba7))

## 0.2.8 - 2026-08-02

### Fixes

- **auth**: make OpenApiCapableAuth accept a real instance, correct the drizzle doc ([`be5c554`](https://github.com/petarzarkov/dunx/commit/be5c554dfb5ff43fa20f54f536ab2c2c04949bce))
- **openapi**: stop re-prefixing contributed paths ([`a6b7803`](https://github.com/petarzarkov/dunx/commit/a6b7803d3d83bcb276d00458abe851d56aecd1eb))
- **core**: allow overriding a self-bound class, and stop two misleading errors ([`5cac915`](https://github.com/petarzarkov/dunx/commit/5cac915c1ab3582fa16d4f21e57e20ed9d4cc365))

### Documentation

- **roadmap**: record seven findings from porting the template ([`3497a4c`](https://github.com/petarzarkov/dunx/commit/3497a4c1805c0052baa215e0a9e51f1a7018cd5d))

## 0.2.7 - 2026-08-02

### Features

- **docs**: draw the request lifecycle as nesting, and add motion ([`417cee6`](https://github.com/petarzarkov/dunx/commit/417cee6205c6f4bec87c1a4c13fe49f4c3155aef))
- **openapi**: put the explorer behind ./ui, and turn on build splitting ([`e8fe0ec`](https://github.com/petarzarkov/dunx/commit/e8fe0ecfeed8d9864acb0a7f8be7b3efa44dd0ae))

### Documentation

- **roadmap**: record what the design pass delivered ([`43789d7`](https://github.com/petarzarkov/dunx/commit/43789d70fb5c18d8b30f37e8691edb0ecd204920))

### Other changes

- openapi explorer behind ./ui, build splitting on ([`19a2489`](https://github.com/petarzarkov/dunx/commit/19a2489e4ed4c61972f126165182e2ffb312b3c0))

## 0.2.6 - 2026-08-02

### Fixes

- **infra**: drop the false ioredis advice, default colour to Bun.enableANSIColors ([`cd8b5d7`](https://github.com/petarzarkov/dunx/commit/cd8b5d7cfc841e2df73210180c074f97c896ce66))
- **release**: sync bun.lock in the version commit ([`1a12271`](https://github.com/petarzarkov/dunx/commit/1a1227167f98a38c9462d0a5fc90e73c4a8bcd92))

### Performance

- **docs**: split the model per route, and prove the explorer renders responses ([`c4a1888`](https://github.com/petarzarkov/dunx/commit/c4a18883d7b726ee1193218e33585bdd2c1c810d))

### Other changes

- docs bundle split, and settle the ioredis, auth-name, versioning and arkv decisions ([`e4642a7`](https://github.com/petarzarkov/dunx/commit/e4642a7e86968bdeed5659b1c6941fbbff55d080))
- split the docs model per route ([`35bc952`](https://github.com/petarzarkov/dunx/commit/35bc95224b432dd9f3eaf2dbab3c34a016c312be))

## 0.2.5 - 2026-08-02

### Documentation

- **roadmap**: record that the explorer does not render response bodies ([`7cdef7d`](https://github.com/petarzarkov/dunx/commit/7cdef7db7f3dd4c9f8b443e0c9b779b06920c6e4))

### Other changes

- release version bump ([`fca14d6`](https://github.com/petarzarkov/dunx/commit/fca14d69e525b2d999f3ce664e997803a8748674))

## 0.2.4 - 2026-08-02

### Fixes

- **bench**: refuse to run when oha is missing instead of degrading silently ([`01e6d5c`](https://github.com/petarzarkov/dunx/commit/01e6d5cfb9034683005aa5f606270e6429179580))

### Other changes

- release version bump ([`556a41f`](https://github.com/petarzarkov/dunx/commit/556a41fcb88d3cab64da6622b70afeadab1a54a9))

## 0.2.3 - 2026-08-02

### Other changes

- release version bump ([`5f284d7`](https://github.com/petarzarkov/dunx/commit/5f284d7638118b439fd90cb51d108dfbe002e917))
- HTTP, infra and testing fixes ([`db2a7da`](https://github.com/petarzarkov/dunx/commit/db2a7da9cf70f443151e458dc0d9723d3e4a6e34))

## 0.2.2 - 2026-08-02

### Fixes

- **http,infra,testing**: request-id validation, error mapper, drizzle options ([`764d248`](https://github.com/petarzarkov/dunx/commit/764d248f783ff0711dd0df6dbd588b5bcf80179e))

### Other changes

- release 0.2.1 version bump ([`af8763a`](https://github.com/petarzarkov/dunx/commit/af8763a0d9318c6254f47c39ab1b04da729b6454))
- OpenAPI response schemas, ApiDoc composition, forRootAsync ([`bd1c712`](https://github.com/petarzarkov/dunx/commit/bd1c712ccd741a937c9cd7c5675514a6d39321e3))

## 0.2.1 - 2026-08-02

### Features

- **openapi**: document response bodies, compose @ApiDoc, and add forRootAsync ([`82a5e3c`](https://github.com/petarzarkov/dunx/commit/82a5e3cd852167c98c8363848570a392c8716d4b))
- **docs**: put the speed panel first, and record cross-language subjects ([`d1d06b0`](https://github.com/petarzarkov/dunx/commit/d1d06b04bc5c1dd555c752a055cfb64bbf5b11d2))
- **docs**: group the guide nav into sections ([`4d67d25`](https://github.com/petarzarkov/dunx/commit/4d67d25dfea0b22ce29ee6af8f797e5d5a4f61b3))
- **docs**: the "N times faster" panel, computed from the run ([`a1de469`](https://github.com/petarzarkov/dunx/commit/a1de469b20bd20f7bc8e72b00aa47be5e6bb6b55))

### Fixes

- publish caret peer ranges, enforce max-lines, unblock create-app in a git dir ([`cef9ed4`](https://github.com/petarzarkov/dunx/commit/cef9ed4b14bd1a42606c5efc3f8827e0ae2fc9fd))

### Documentation

- **roadmap**: add the porting findings to the index ([`d589cf5`](https://github.com/petarzarkov/dunx/commit/d589cf518c7a6a384f334e99a653c55330fc2931))
- **roadmap**: 22 findings from porting nestjs-template onto published dunx ([`2b80eb8`](https://github.com/petarzarkov/dunx/commit/2b80eb82102bde472f78369c39f640f5d304b092))
- one roadmap file per open item, and measure AsyncLocalStorage ([`a2f9337`](https://github.com/petarzarkov/dunx/commit/a2f93374774f4ff754033506285bb79fb7507e9f))

### Other changes

- packaging, lint and create-app fixes ([`9c47a1d`](https://github.com/petarzarkov/dunx/commit/9c47a1d8459cbd8296913b57c80f1a13fa4a7a2a))

## 0.2.0 - 2026-08-02

### Features

- **openapi,auth**: merge Better Auth's schema into the app's document ([`c659aae`](https://github.com/petarzarkov/dunx/commit/c659aaeb38cd3dd7a7dd26a03df2e195afa0126f))
- **docs**: syntax highlighting everywhere, with no highlighter in the bundle ([`cde1dc8`](https://github.com/petarzarkov/dunx/commit/cde1dc8c3ff585a2f3a66c39b3fc057dc9ddb46a))

### Fixes

- **docs**: create the generated directory before writing into it ([`b345680`](https://github.com/petarzarkov/dunx/commit/b3456808464613716f208725bb68742353df138a))

## 0.1.1 - 2026-08-02

### Breaking changes

- rename @dunx/compiler to @dunx/transform ([`d437094`](https://github.com/petarzarkov/dunx/commit/d437094ff72c6545984825118688410ce975e825))

### Features

- **infra**: consume queues inside a container that already exists ([`804434b`](https://github.com/petarzarkov/dunx/commit/804434b888c95001f589bf590746d747622ddc02))
- **docs**: a guide tree, separate from the repo's own reference docs ([`3f88448`](https://github.com/petarzarkov/dunx/commit/3f88448ea27ba4e8c6e2f19b3a08144caeb2d3e4))
- **create-app**: scaffold a new dunx app - roadmap item 2 ([`5a9ab03`](https://github.com/petarzarkov/dunx/commit/5a9ab039c104f86c4f20ae888d1cf91deefec605))
- **docs**: reference the examples from the landing page ([`24dbb76`](https://github.com/petarzarkov/dunx/commit/24dbb76c58233fc8ecf3942db0eda1be5d0b7a82))
- **examples**: a ladder of examples - minimal, databases, testing, full ([`5cd2bd9`](https://github.com/petarzarkov/dunx/commit/5cd2bd93896e2ef9b07ceb5a854a456ebe85bea4))
- **docs**: a logo - the wordmark's own `n` sheltering its `x` ([`411f365`](https://github.com/petarzarkov/dunx/commit/411f3651aa7c7f99bf29bdfb576e0030920f8b4c))
- **docs**: deepen the landing page - code tour, request lifecycle, and the losses ([`3c904dd`](https://github.com/petarzarkov/dunx/commit/3c904dd67b94d9e82e2e456ffb06c7983e43d7dd))
- **docs**: a real landing page - full-width hero, stat band, feature grid, footer ([`8fe1c77`](https://github.com/petarzarkov/dunx/commit/8fe1c7745af80119fe0ad49eaf7a9992042de2bb))
- **infra**: add a synchronous SQLite mode alongside the async one ([`1fb99e6`](https://github.com/petarzarkov/dunx/commit/1fb99e6803237b5b0be5a19beea4ca05d39c6e01))
- **openapi**: replace the hand-written docs page with a real Mantine UI ([`12b2d44`](https://github.com/petarzarkov/dunx/commit/12b2d443a34995fda5a0cb11f9ed1583ca953ff9))
- **docs**: fix search anchors, trim repo-setup sections, switch to Vite ([`850a9f2`](https://github.com/petarzarkov/dunx/commit/850a9f2f53ff72bd5effa6f16d9d8da83c354a5c))
- **bench**: add NestJS subjects on the Express and Fastify adapters ([`22615ad`](https://github.com/petarzarkov/dunx/commit/22615ad71577132d533dca3ec30ebf543b37d381))
- **validation**: implement validation cost harness and reporting ([`d7dc020`](https://github.com/petarzarkov/dunx/commit/d7dc020e6201c7bcb260fe8dde0c68c2b4909aef))
- **testing**: add testing package with createTestApp and createTestServer ([`1537362`](https://github.com/petarzarkov/dunx/commit/153736229b5f150256c055b1f6f9c902446c7f34))
- add benchmarks page and related components ([`00c5d26`](https://github.com/petarzarkov/dunx/commit/00c5d26a89cff05121954f44d228c40cdc4162be))
- docs, bench, logger, default middleware, update example, ci ([`59bc37e`](https://github.com/petarzarkov/dunx/commit/59bc37eb28b9ad45f283eb65ac93839b5a2ae61a))
- unify ([`9880d44`](https://github.com/petarzarkov/dunx/commit/9880d446e2d97918f8f3bfe490865cc512f90fa9))
- wire it all up ([`fad4a2f`](https://github.com/petarzarkov/dunx/commit/fad4a2f7c2cabb648051703d48ea71334be0f119))
- add http, compiler, update core, update example ([`cf2d63f`](https://github.com/petarzarkov/dunx/commit/cf2d63f8fc4c7b905e8caf1815a27f3003b63b8d))
- add core DI functionality and example app to test it and wire it all together ([`72e93fd`](https://github.com/petarzarkov/dunx/commit/72e93fd6cbe46e706e9ff641a4f0137878a0d5d1))
- add an example package ([`d086a11`](https://github.com/petarzarkov/dunx/commit/d086a11166636fb69782621ebbcc00deff6c3c5e))

### Fixes

- declare Apache-2.0, which is what the LICENSE files actually are ([`107747c`](https://github.com/petarzarkov/dunx/commit/107747cda7c20c59b5aee263bf75b90649dce5d7))
- **scripts**: the dash guard could not see untracked files ([`d8a2cab`](https://github.com/petarzarkov/dunx/commit/d8a2cabe9a22671c7cf9c9c6c090a35c84004bf7))
- **docs**: a guard does not return false, and does not stop construction ([`94d4045`](https://github.com/petarzarkov/dunx/commit/94d4045215c7fca8b69283b1a6814d232a1a5ca0))
- **release**: unpin @dunx/infra's peer, and stop process.exit from causing it ([`73185da`](https://github.com/petarzarkov/dunx/commit/73185dae0f0ef15d0951f51dda07817774d4b900))
- **release**: actually increment the publish counter ([`dc0a19a`](https://github.com/petarzarkov/dunx/commit/dc0a19ab2e03cc6ecc4e3bbde3eb268523cdc6d8))
- **release**: make first-publish resumable and pace it past npm's rate limit ([`420c172`](https://github.com/petarzarkov/dunx/commit/420c172eed6e1ed7c2e0b7e7e8aca20ebaf65e12))
- **release**: the first-publish script could not do 2FA, and npm was dropping the CLI's bin ([`3eca551`](https://github.com/petarzarkov/dunx/commit/3eca551d73d212dacca38ae56f1b49c42ffc08a4))
- **http**: retry a websocket relay's boot subscribe ([`eb6a9c1`](https://github.com/petarzarkov/dunx/commit/eb6a9c1b8fc62fd939e1dcab563c2fc6327910c9))
- **docs**: landing page on a phone ([`56a5a98`](https://github.com/petarzarkov/dunx/commit/56a5a9811c4ddab19277c818e57fd8453bea7ff8))
- ensure public directory exists before copying assets ([`29dd8ef`](https://github.com/petarzarkov/dunx/commit/29dd8efd0bdd302f862faaa1f66474d6dd1db22c))
- **core**: bound findNestedError, and rewrite Rule 1 around reuse ([`4639169`](https://github.com/petarzarkov/dunx/commit/463916929d710556e78be24843980f7519a16266))

### Performance

- **http,core**: cut request-logging overhead, and fix the harness that inflated it ([`6f25baa`](https://github.com/petarzarkov/dunx/commit/6f25baaf0241c34b59fb4a425ec1f057194cc2a5))

### Refactors

- @dunx/core and @dunx/http are peerDependencies - roadmap item 1 ([`53aba4d`](https://github.com/petarzarkov/dunx/commit/53aba4dd3757d237c65abee5b283c0f70088cf16))
- back Logger with @arkv/logger instead of a port ([`1544eca`](https://github.com/petarzarkov/dunx/commit/1544eca0434c9400ae00073d9cb4a35d9cdcf330))

### Documentation

- correct two CLAUDE.md entries the contributing pass found stale ([`b557424`](https://github.com/petarzarkov/dunx/commit/b55742462f4abf4b6f905c83e096009095b3c11c))
- contributing guide, PR template and issue templates ([`50d99e4`](https://github.com/petarzarkov/dunx/commit/50d99e4df1b9f426b5cf91974ecd8492dbb7a60d))
- **guide**: configuration, logging, database, queues, auth, files and images ([`965b962`](https://github.com/petarzarkov/dunx/commit/965b96261ccae2f54b3ad8f97099cb3b3764f07b))
- **guide**: introduction, first steps, providers, modules, controllers ([`cb9ca5e`](https://github.com/petarzarkov/dunx/commit/cb9ca5ededd43b096a386003499ec7a9f8ae7b32))
- **guide**: validation, middleware and guards, websockets, openapi, testing ([`9a8ae8e`](https://github.com/petarzarkov/dunx/commit/9a8ae8e0fda0d105b94c99f62f302a6e82f74390))
- **roadmap**: record in-process worker composition as fixed ([`85793b4`](https://github.com/petarzarkov/dunx/commit/85793b4b288fbfb628817c3ae9e7ce168d8a4d17))
- say what the dash rule means when the character is the subject ([`5964327`](https://github.com/petarzarkov/dunx/commit/596432787181c49790d175bfe015d16f182cbefe))
- record the logo system and the concepts that failed ([`48afecd`](https://github.com/petarzarkov/dunx/commit/48afecd6bb6b912f1f572d916f049247aadaf770))
- **roadmap**: record the topological build, and what peers still need ([`eeefbac`](https://github.com/petarzarkov/dunx/commit/eeefbace204da024077255751d805c70edc68267))
- correct the db layer, the Date trap, and the stale tables ([`bd63c75`](https://github.com/petarzarkov/dunx/commit/bd63c75156bb6ede811afa6f4d04413555d7acfb))

### Other changes

- contributing documentation ([`a8f524f`](https://github.com/petarzarkov/dunx/commit/a8f524fdf82f3b7fb40be2e541a44395ebdcda52))
- enable the version bump and publish step ([`1f773de`](https://github.com/petarzarkov/dunx/commit/1f773de3a5f173f7e48c96ba4b55313c90fc7952))
- infrastructure guides ([`4885ffb`](https://github.com/petarzarkov/dunx/commit/4885ffb3e3d15d02fb64bcf8327207a84d01ecea))
- fundamentals guides ([`f32dd7f`](https://github.com/petarzarkov/dunx/commit/f32dd7fd1fa1bb1cb8ea499840bef99144d80ab8))
- format the HTTP-layer guides ([`8d2f222`](https://github.com/petarzarkov/dunx/commit/8d2f222587cef902b50b8ce0fd1c31506c8528c5))
- HTTP-layer guides ([`3215313`](https://github.com/petarzarkov/dunx/commit/3215313103d236d97f8dfe56a4667938962cf917))
- format the deployment guide ([`788f9a9`](https://github.com/petarzarkov/dunx/commit/788f9a97c9dfde8643b7ed13cfea65ee2597f3d3))
- remove every em and en dash, and add a rule plus a guard ([`288e64d`](https://github.com/petarzarkov/dunx/commit/288e64da005df3d078408571f8fdd6a2357e6420))
- format the manifests after the repository.url normalisation ([`3ab7b19`](https://github.com/petarzarkov/dunx/commit/3ab7b193808f6ef3514ac8ee24e9b9fc35e25a5d))
- **release**: version 0.1.0 and a script for the first publish ([`f04c5cf`](https://github.com/petarzarkov/dunx/commit/f04c5cf90ea9c0e0ce9e3d71ce2a9951b0a34f9b))
- the clean run - idle machine, every baseline inside the noise floor ([`ff4c579`](https://github.com/petarzarkov/dunx/commit/ff4c579102d615d01ec44db1c5b5765ca09e8089))
- the examples ladder ([`3435dd4`](https://github.com/petarzarkov/dunx/commit/3435dd4bf83729894c548f99ce3fa0fc3bcf4ea0))
- publish the run that includes both NestJS subjects ([`9d8b456`](https://github.com/petarzarkov/dunx/commit/9d8b456a3b8a5ebb374378a8047196dfc1533ea3))
- the dunx logo ([`a0ed495`](https://github.com/petarzarkov/dunx/commit/a0ed495220adeff3104f09a482ae288cb8d025d1))
- topological workspace build, and fix the NestJS entrypoint collision ([`bedda97`](https://github.com/petarzarkov/dunx/commit/bedda971119af1036e1d86e690e65a17b6ca3f0e))
- request-logging overhead and the harness pipe fix ([`610ce58`](https://github.com/petarzarkov/dunx/commit/610ce58fdced54e3ffcce48e7e6f970175f120dc))
- synchronous SQLite mode ([`d833379`](https://github.com/petarzarkov/dunx/commit/d833379b0a0745c2aa849b05b4834001addc3362))
- real OpenAPI UI bundle ([`b77b199`](https://github.com/petarzarkov/dunx/commit/b77b199e14f7355b4b673d5cd051797dbf1858c0))
- docs site search, content trimming, and Vite ([`e6da4ac`](https://github.com/petarzarkov/dunx/commit/e6da4acc7c05ce6c8205fc40aa083d8a25afe526))
- Add script to regenerate results tables in README from benchmark results ([`6d464e8`](https://github.com/petarzarkov/dunx/commit/6d464e889d7117617dd72f57ecaefefe6a18a1b5))
- savepoint ([`e25b127`](https://github.com/petarzarkov/dunx/commit/e25b127a780007d90717c268201742b1adb3efec))
- yo ([`244734f`](https://github.com/petarzarkov/dunx/commit/244734f4160ac0190a6a19fbcd670a004ca475a7))
- fixes ([`9e7a293`](https://github.com/petarzarkov/dunx/commit/9e7a293e9122af6d0112794de3f86169636d3eb7))
- xxx ([`d0c198a`](https://github.com/petarzarkov/dunx/commit/d0c198ac295942eb50ee94555ba11d508bf0f303))
- add pre commit hook and format docs ([`726295c`](https://github.com/petarzarkov/dunx/commit/726295c9e85b8475b3258f76763a18121b77b4b9))
- update concerns in architecture doc ([`27ab0a8`](https://github.com/petarzarkov/dunx/commit/27ab0a846b2b2b2809b8325a9c5e6df0f24ab4d8))
- add handoff skills ([`6573309`](https://github.com/petarzarkov/dunx/commit/65733099803285d7f3205ca4fb4bc922df83b2ce))
- initial ([`519c155`](https://github.com/petarzarkov/dunx/commit/519c155743468fefa4843b3e49a5618ca811ea23))
- Initial commit ([`4536ef0`](https://github.com/petarzarkov/dunx/commit/4536ef095b51ca01a9293ef28b9b2a5647694eb2))
