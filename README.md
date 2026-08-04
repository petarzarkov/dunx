<div align="center">

<img src="tools/docs/public/logo/logo-mark-color.svg" width="96" height="96" alt="" />

# dunx

A Bun-native dependency injection framework - enterprise structure, Bun-native speed.

[![CI](https://github.com/petarzarkov/dunx/actions/workflows/ci.yml/badge.svg)](https://github.com/petarzarkov/dunx/actions/workflows/ci.yml)
[![coverage](https://petarzarkov.github.io/dunx/badges/coverage.svg)](https://petarzarkov.github.io/dunx/#/coverage)
[![docs](https://img.shields.io/badge/docs-petarzarkov.github.io%2Fdunx-blue)](https://petarzarkov.github.io/dunx)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![TypeScript](https://img.shields.io/badge/TypeScript-7.0-blue.svg)](https://www.typescriptlang.org/)
[![Bun](https://img.shields.io/badge/Bun-%E2%89%A51.3-black.svg)](https://bun.sh)

</div>

Standard (TC39) decorators, no `reflect-metadata`, no `tsyringe`, and no
per-request container work. Routing is delegated to Bun's native router rather
than reimplemented in JavaScript.

The same principle decides everything else: what Bun ships is never reimplemented,
and what a mature library already solves is never invented. So the DI container,
the HTTP adapter and the OpenAPI generator are dunx's, while the database layer is
**drizzle** over `bun:sqlite`/`Bun.SQL` and the logger is **`@arkv/logger`** bound
to a `Logger` contract that `@dunx/core` declares and nothing else in core depends
on.

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the design and the
measurements behind it, and [docs/ROADMAP.md](docs/ROADMAP.md) for what is built
and what is next.

## Packages

| Package | Npm | Coverage | Description |
|---------|---------|----------|-------------|
| [`@dunx/auth`](./packages/auth) | [![npm](https://img.shields.io/npm/v/%40dunx%2Fauth)](https://www.npmjs.com/package/%40dunx%2Fauth) [![dls](https://img.shields.io/npm/dt/%40dunx%2Fauth?label=dls)](https://www.npmjs.com/package/%40dunx%2Fauth) [![size](https://img.shields.io/npm/unpacked-size/%40dunx%2Fauth?label=size)](https://www.npmjs.com/package/%40dunx%2Fauth) | [![cov](https://petarzarkov.github.io/dunx/badges/coverage-auth.svg)](https://petarzarkov.github.io/dunx/#/coverage) | Better Auth for dunx: its handler mounted on Bun.serve, a session guard reading @Public() and @Roles(), the caller in async context, and Bun.password hashing |
| [`@dunx/core`](./packages/core) | [![npm](https://img.shields.io/npm/v/%40dunx%2Fcore)](https://www.npmjs.com/package/%40dunx%2Fcore) [![dls](https://img.shields.io/npm/dt/%40dunx%2Fcore?label=dls)](https://www.npmjs.com/package/%40dunx%2Fcore) [![size](https://img.shields.io/npm/unpacked-size/%40dunx%2Fcore?label=size)](https://www.npmjs.com/package/%40dunx%2Fcore) | [![cov](https://petarzarkov.github.io/dunx/badges/coverage-core.svg)](https://petarzarkov.github.io/dunx/#/coverage) | DI container, modules, lifecycle and the injectable Logger contract for the dunx framework |
| [`@dunx/create-app`](./packages/create-app) | [![npm](https://img.shields.io/npm/v/%40dunx%2Fcreate-app)](https://www.npmjs.com/package/%40dunx%2Fcreate-app) [![dls](https://img.shields.io/npm/dt/%40dunx%2Fcreate-app?label=dls)](https://www.npmjs.com/package/%40dunx%2Fcreate-app) [![size](https://img.shields.io/npm/unpacked-size/%40dunx%2Fcreate-app?label=size)](https://www.npmjs.com/package/%40dunx%2Fcreate-app) | [![cov](https://petarzarkov.github.io/dunx/badges/coverage-create-app.svg)](https://petarzarkov.github.io/dunx/#/coverage) | Scaffold a new dunx application - bunx @dunx/create-app my-api |
| [`@dunx/http`](./packages/http) | [![npm](https://img.shields.io/npm/v/%40dunx%2Fhttp)](https://www.npmjs.com/package/%40dunx%2Fhttp) [![dls](https://img.shields.io/npm/dt/%40dunx%2Fhttp?label=dls)](https://www.npmjs.com/package/%40dunx%2Fhttp) [![size](https://img.shields.io/npm/unpacked-size/%40dunx%2Fhttp?label=size)](https://www.npmjs.com/package/%40dunx%2Fhttp) | [![cov](https://petarzarkov.github.io/dunx/badges/coverage-http.svg)](https://petarzarkov.github.io/dunx/#/coverage) | Bun.serve adapter for the dunx framework: controllers, middleware and WebSocket gateways |
| [`@dunx/infra`](./packages/infra) | [![npm](https://img.shields.io/npm/v/%40dunx%2Finfra)](https://www.npmjs.com/package/%40dunx%2Finfra) [![dls](https://img.shields.io/npm/dt/%40dunx%2Finfra?label=dls)](https://www.npmjs.com/package/%40dunx%2Finfra) [![size](https://img.shields.io/npm/unpacked-size/%40dunx%2Finfra?label=size)](https://www.npmjs.com/package/%40dunx%2Finfra) | [![cov](https://petarzarkov.github.io/dunx/badges/coverage-infra.svg)](https://petarzarkov.github.io/dunx/#/coverage) | Database, Redis, queue, storage, image and logging infrastructure for dunx. drizzle over bun:sqlite and Bun.SQL, bullmq over Bun.RedisClient, plus Bun.file, Bun.Glob, Bun.S3Client, Bun.Image and @arkv/logger |
| [`@dunx/mcp`](./packages/mcp) | [![npm](https://img.shields.io/npm/v/%40dunx%2Fmcp)](https://www.npmjs.com/package/%40dunx%2Fmcp) [![dls](https://img.shields.io/npm/dt/%40dunx%2Fmcp?label=dls)](https://www.npmjs.com/package/%40dunx%2Fmcp) [![size](https://img.shields.io/npm/unpacked-size/%40dunx%2Fmcp?label=size)](https://www.npmjs.com/package/%40dunx%2Fmcp) | [![cov](https://petarzarkov.github.io/dunx/badges/coverage-mcp.svg)](https://petarzarkov.github.io/dunx/#/coverage) | A Model Context Protocol server for dunx apps - bunx @dunx/mcp ./src/app.module.ts |
| [`@dunx/openapi`](./packages/openapi) | [![npm](https://img.shields.io/npm/v/%40dunx%2Fopenapi)](https://www.npmjs.com/package/%40dunx%2Fopenapi) [![dls](https://img.shields.io/npm/dt/%40dunx%2Fopenapi?label=dls)](https://www.npmjs.com/package/%40dunx%2Fopenapi) [![size](https://img.shields.io/npm/unpacked-size/%40dunx%2Fopenapi?label=size)](https://www.npmjs.com/package/%40dunx%2Fopenapi) | [![cov](https://petarzarkov.github.io/dunx/badges/coverage-openapi.svg)](https://petarzarkov.github.io/dunx/#/coverage) | OpenAPI 3.1 documents and a dependency-free docs page for dunx controllers, generated from the schemas the routes already validate |
| [`@dunx/queue-dashboard`](./packages/queue-dashboard) | [![npm](https://img.shields.io/npm/v/%40dunx%2Fqueue-dashboard)](https://www.npmjs.com/package/%40dunx%2Fqueue-dashboard) [![dls](https://img.shields.io/npm/dt/%40dunx%2Fqueue-dashboard?label=dls)](https://www.npmjs.com/package/%40dunx%2Fqueue-dashboard) [![size](https://img.shields.io/npm/unpacked-size/%40dunx%2Fqueue-dashboard?label=size)](https://www.npmjs.com/package/%40dunx%2Fqueue-dashboard) | [![cov](https://petarzarkov.github.io/dunx/badges/coverage-queue-dashboard.svg)](https://petarzarkov.github.io/dunx/#/coverage) | bull-board mounted on Bun.serve for a dunx app - an opt-in dashboard for @dunx/infra/queue |
| [`@dunx/testing`](./packages/testing) | [![npm](https://img.shields.io/npm/v/%40dunx%2Ftesting)](https://www.npmjs.com/package/%40dunx%2Ftesting) [![dls](https://img.shields.io/npm/dt/%40dunx%2Ftesting?label=dls)](https://www.npmjs.com/package/%40dunx%2Ftesting) [![size](https://img.shields.io/npm/unpacked-size/%40dunx%2Ftesting?label=size)](https://www.npmjs.com/package/%40dunx%2Ftesting) | [![cov](https://petarzarkov.github.io/dunx/badges/coverage-testing.svg)](https://petarzarkov.github.io/dunx/#/coverage) | Test harness for dunx apps: a container with providers replaced in place, and a real Bun.serve on port 0 |
| [`@dunx/transform`](./packages/transform) | [![npm](https://img.shields.io/npm/v/%40dunx%2Ftransform)](https://www.npmjs.com/package/%40dunx%2Ftransform) [![dls](https://img.shields.io/npm/dt/%40dunx%2Ftransform?label=dls)](https://www.npmjs.com/package/%40dunx%2Ftransform) [![size](https://img.shields.io/npm/unpacked-size/%40dunx%2Ftransform?label=size)](https://www.npmjs.com/package/%40dunx%2Ftransform) | [![cov](https://petarzarkov.github.io/dunx/badges/coverage-transform.svg)](https://petarzarkov.github.io/dunx/#/coverage) | Load-time transform that records constructor dependencies for the dunx container |

## Examples

A ladder, not one per package - each answers the next question an evaluator asks.
All four are kept alive by CI, and each exits 0 with no database, Redis or S3
installed.

| Example                                    | Answers                                                            |
| ------------------------------------------ | -------------------------------------------------------------------- |
| [`examples/minimal`](./examples/minimal)     | What does it look like? Five files, read top to bottom in two minutes |
| [`examples/databases`](./examples/databases) | How do I set up a database? SQLite (async and sync), Postgres, MySQL  |
| [`examples/testing`](./examples/testing)     | How do I test it? Overrides, a real server on port 0, a guard         |
| [`examples/full`](./examples/full)           | Does it compose? Every package in one long-running service            |

```bash
bun install
bun run --filter '@dunx/example-minimal' start
```

## Project Structure

```
dunx/
├── packages/            # Published packages
│   ├── auth             # Better Auth for dunx: its handler mounted on Bun.serve, a session guard reading @Public() and @Roles(), the caller in async context, and Bun.password hashing
│   ├── core             # DI container, modules, lifecycle and the injectable Logger contract for the dunx framework
│   ├── create-app       # Scaffold a new dunx application - bunx @dunx/create-app my-api
│   ├── http             # Bun.serve adapter for the dunx framework: controllers, middleware and WebSocket gateways
│   ├── infra            # Database, Redis, queue, storage, image and logging infrastructure for dunx
│   ├── mcp              # A Model Context Protocol server for dunx apps - bunx @dunx/mcp ./src/app.module.ts
│   ├── openapi          # OpenAPI 3.1 documents and a dependency-free docs page for dunx controllers, generated from the schemas the routes already validate
│   ├── queue-dashboard  # bull-board mounted on Bun.serve for a dunx app - an opt-in dashboard for @dunx/infra/queue
│   ├── testing          # Test harness for dunx apps: a container with providers replaced in place, and a real Bun.serve on port 0
│   └── transform        # Load-time transform that records constructor dependencies for the dunx container
├── examples/            # Private apps that consume the packages
├── tools/               # Private workspaces, never published - docs site, benchmarks, API explorer
├── docs/                # Architecture and design docs
├── scripts/             # Monorepo-level scripts
├── .github/workflows/   # CI/CD pipeline
└── .husky/              # Git hooks
```

## Development

```bash
# Install all dependencies
bun install

# Build all packages
bun run build

# Run all tests
bun run test

# Run tests with coverage
bun run test:cov

# Lint & format
bun run lint
bun run format

# Typecheck
bun run typecheck
```

## Scripts

| Script | Description |
|---|---|
| `bun run build` | Build all packages (ESM + type declarations) |
| `bun run test` | Run all tests |
| `bun run test:cov` | Run all tests with coverage, then build the coverage report |
| `bun run gen:cov` | Rebuild the coverage model and badges from existing coverage data, into `tools/docs` |
| `bun run docs:dev` | Extract the API reference and serve the documentation site locally |
| `bun run docs:build` | Build the documentation site to `tools/docs/dist` (the GitHub Pages artifact) |
| `bun run gen:readme` | Regenerate the Packages table and Project Structure block |
| `bun run lint` | Lint and auto-fix with oxlint |
| `bun run lint:check` | Lint without fixing (used by CI) |
| `bun run format` | Format code with oxfmt |
| `bun run format:check` | Verify formatting without writing (used by CI) |
| `bun run typecheck` | Typecheck all packages |
| `bun run install:clean` | Remove every `node_modules` and `bun.lock`, then reinstall |
| `bun run version` | Bump versions based on conventional commits |
| `bun run version:dry-run` | Preview version bump |

## Adding a New Package

1. Create a directory under `packages/`
2. Add a `package.json` with `"name": "@dunx/<name>"` and `"type": "module"`
3. Add a `tsconfig.json` extending the root config - one per package, no build variants
4. Set `"build": "bun ../../scripts/build-package.ts"`; entrypoints are derived
   from the `exports` and `bin` fields, so nothing else needs configuring
5. For internal-only packages, set `"private": true`

Every package is **ESM only**. Relative imports must carry a `.js` extension -
`tsc` copies the specifier verbatim into the emitted `.d.ts`, and an
extensionless one fails to resolve for consumers on `node16`/`nodenext`. The
root tsconfig uses `moduleResolution: nodenext` so this is a compile error
rather than something a consumer discovers.

## Commit Convention

Commits follow [Conventional Commits](https://www.conventionalcommits.org/):

```
type(scope)?: description
```

Allowed types: `feat`, `fix`, `chore`, `docs`, `test`, `style`, `refactor`, `perf`, `build`, `ci`, `revert`, `security`, `sync`

## Versioning & Publishing

On push to `main`, CI automatically:

1. Lints, formats, typechecks, builds, and tests all packages
2. Bumps versions of publishable packages based on commit type
3. Publishes **only packages whose source code changed**

| Commit type | Version bump |
|---|---|
| `feat:` | minor |
| `fix:`, `chore:`, etc. | patch |
| Breaking change (`!:`) | major |

## Contributing

Pull requests are welcome. [CONTRIBUTING.md](CONTRIBUTING.md) is the full guide:
how to get set up, which checks CI runs, the repo's rules on native
implementations and third-party dependencies, and the house style that a review
will hold you to.

The short version: Bun only, no `npm`/`npx`/`yarn`/`pnpm`; `bun install` then
`bun run build` before anything else; run `lint:check`, `format:check`,
`typecheck` and `test:cov` before you push; conventional commits; a bug fix comes
with the test that would have caught it; and a claim about performance comes with
the numbers.

## License

[MIT](LICENSE)
