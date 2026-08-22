# Changelog

Every release, newest first. Written by `bun run version` from the commits in the
release range. Every @dunx package shares one version and ships together, so a
release covers all of them.

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
