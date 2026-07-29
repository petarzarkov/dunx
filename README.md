<div align="center">

# dunx

A Bun-native dependency injection framework — NestJS-shaped ergonomics, none of the NestJS runtime.

[![CI](https://github.com/petarzarkov/dunx/actions/workflows/ci.yml/badge.svg)](https://github.com/petarzarkov/dunx/actions/workflows/ci.yml)
[![coverage](https://petarzarkov.github.io/dunx/coverage.svg)](https://petarzarkov.github.io/dunx)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![TypeScript](https://img.shields.io/badge/TypeScript-7.0-blue.svg)](https://www.typescriptlang.org/)
[![Bun](https://img.shields.io/badge/Bun-%E2%89%A51.3-black.svg)](https://bun.sh)

</div>

Standard (TC39) decorators, no `reflect-metadata`, no `tsyringe`, and no
per-request container work. Routing is delegated to Bun's native router rather
than reimplemented in JavaScript.

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the design and the phased
roadmap.

## Packages

| Package | Npm | Coverage | Description |
|---------|---------|----------|-------------|
| [`@dunx/compiler`](./packages/compiler) | [![npm](https://img.shields.io/npm/v/%40dunx%2Fcompiler)](https://www.npmjs.com/package/%40dunx%2Fcompiler) [![dls](https://img.shields.io/npm/dt/%40dunx%2Fcompiler?label=dls)](https://www.npmjs.com/package/%40dunx%2Fcompiler) [![size](https://img.shields.io/npm/unpacked-size/%40dunx%2Fcompiler?label=size)](https://www.npmjs.com/package/%40dunx%2Fcompiler) | [![cov](https://petarzarkov.github.io/dunx/coverage-compiler.svg)](https://petarzarkov.github.io/dunx#compiler) | Load-time transform that records constructor dependencies for the dunx container |
| [`@dunx/core`](./packages/core) | [![npm](https://img.shields.io/npm/v/%40dunx%2Fcore)](https://www.npmjs.com/package/%40dunx%2Fcore) [![dls](https://img.shields.io/npm/dt/%40dunx%2Fcore?label=dls)](https://www.npmjs.com/package/%40dunx%2Fcore) [![size](https://img.shields.io/npm/unpacked-size/%40dunx%2Fcore?label=size)](https://www.npmjs.com/package/%40dunx%2Fcore) | [![cov](https://petarzarkov.github.io/dunx/coverage-core.svg)](https://petarzarkov.github.io/dunx#core) | Core for the dunx framework |
| [`@dunx/http`](./packages/http) | [![npm](https://img.shields.io/npm/v/%40dunx%2Fhttp)](https://www.npmjs.com/package/%40dunx%2Fhttp) [![dls](https://img.shields.io/npm/dt/%40dunx%2Fhttp?label=dls)](https://www.npmjs.com/package/%40dunx%2Fhttp) [![size](https://img.shields.io/npm/unpacked-size/%40dunx%2Fhttp?label=size)](https://www.npmjs.com/package/%40dunx%2Fhttp) | [![cov](https://petarzarkov.github.io/dunx/coverage-http.svg)](https://petarzarkov.github.io/dunx#http) | Bun.serve adapter for the dunx framework: controllers, middleware and WebSocket gateways |
| [`@dunx/infra`](./packages/infra) | [![npm](https://img.shields.io/npm/v/%40dunx%2Finfra)](https://www.npmjs.com/package/%40dunx%2Finfra) [![dls](https://img.shields.io/npm/dt/%40dunx%2Finfra?label=dls)](https://www.npmjs.com/package/%40dunx%2Finfra) [![size](https://img.shields.io/npm/unpacked-size/%40dunx%2Finfra?label=size)](https://www.npmjs.com/package/%40dunx%2Finfra) | [![cov](https://petarzarkov.github.io/dunx/coverage-infra.svg)](https://petarzarkov.github.io/dunx#infra) | Database, Redis, storage and image infrastructure built on Bun.SQL, bun:sqlite, Bun.RedisClient, Bun.file, Bun.Glob, Bun.S3Client and Bun.Image |
| [`@dunx/openapi`](./packages/openapi) | [![npm](https://img.shields.io/npm/v/%40dunx%2Fopenapi)](https://www.npmjs.com/package/%40dunx%2Fopenapi) [![dls](https://img.shields.io/npm/dt/%40dunx%2Fopenapi?label=dls)](https://www.npmjs.com/package/%40dunx%2Fopenapi) [![size](https://img.shields.io/npm/unpacked-size/%40dunx%2Fopenapi?label=size)](https://www.npmjs.com/package/%40dunx%2Fopenapi) | [![cov](https://petarzarkov.github.io/dunx/coverage-openapi.svg)](https://petarzarkov.github.io/dunx#openapi) | OpenAPI 3.1 documents and a dependency-free docs page for dunx controllers, generated from the schemas the routes already validate |

## Project Structure

```
dunx/
├── packages/           # Published packages
│   ├── compiler        # Load-time transform that records constructor dependencies for the dunx container
│   ├── core            # Core for the dunx framework
│   ├── http            # Bun.serve adapter for the dunx framework: controllers, middleware and WebSocket gateways
│   ├── infra           # Database, Redis, storage and image infrastructure built on Bun.SQL, bun:sqlite, Bun.RedisClient, Bun.file, Bun.Glob, Bun.S3Client and Bun.Image
│   └── openapi         # OpenAPI 3.1 documents and a dependency-free docs page for dunx controllers, generated from the schemas the routes already validate
├── examples/           # Private apps that consume the packages
├── docs/               # Architecture and design docs
├── scripts/            # Monorepo-level scripts
├── .github/workflows/  # CI/CD pipeline
└── .husky/             # Git hooks
```

## Getting Started

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
| `bun run gen:cov` | Rebuild the coverage report and badges from existing coverage data |
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
3. Add a `tsconfig.json` extending the root config — one per package, no build variants
4. Set `"build": "bun ../../scripts/build-package.ts"`; entrypoints are derived
   from the `exports` and `bin` fields, so nothing else needs configuring
5. For internal-only packages, set `"private": true`

Every package is **ESM only**. Relative imports must carry a `.js` extension —
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

## License

[MIT](LICENSE)
