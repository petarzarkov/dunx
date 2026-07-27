<div align="center">

# dunx

A modern TypeScript DI framework powered by bun [Bun](https://bun.sh).

[![CI](https://github.com/petarzarkov/dunx/actions/workflows/ci.yml/badge.svg)](https://github.com/petarzarkov/dunx/actions/workflows/ci.yml)
[![coverage](https://petarzarkov.github.io/dunx/coverage.svg)](https://petarzarkov.github.io/dunx)
[![License: Apache 2.0](https://img.shields.io/badge/License-APACHE-blue.svg)](LICENSE)
[![TypeScript](https://img.shields.io/badge/TypeScript-6.0-blue.svg)](https://www.typescriptlang.org/)
[![Bun](https://img.shields.io/badge/Bun-%E2%89%A51.0-black.svg)](https://bun.sh)

</div>



## Project Structure

```
dunx/
├── packages/                  # Published packages right from npx
├── scripts/                   # Monorepo-level scripts
├── .github/workflows/         # CI/CD pipeline
└── .husky/                    # Git hooks
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
| `bun run build` | Build all packages (ESM + CJS + Types) |
| `bun run test` | Run all tests |
| `bun run test:cov` | Run all tests with coverage, then build the coverage report |
| `bun run gen:cov` | Rebuild the coverage report and badges from existing coverage data |
| `bun run lint` | Lint and auto-fix with oxlint |
| `bun run format` | Format code with oxfmt |
| `bun run typecheck` | Typecheck all packages |
| `bun run install:clean` | Remove every `node_modules` and `bun.lock`, then reinstall |
| `bun run version` | Bump versions based on conventional commits |
| `bun run version:dry-run` | Preview version bump |

## Adding a New Package

1. Create a directory under `packages/`
2. Add a `package.json` with `"name": "@dunx/<name>"`
3. Add a `tsconfig.json` extending the root config
4. For publishable packages, add build tsconfigs (ESM + CJS + Types)
5. For internal-only packages, set `"private": true`

## Commit Convention

Commits follow [Conventional Commits](https://www.conventionalcommits.org/):

```
type(scope)?: description
```

Allowed types: `feat`, `fix`, `chore`, `docs`, `test`, `style`, `refactor`, `perf`, `build`, `ci`, `revert`, `security`, `sync`

## Versioning & Publishing

On push to `main`, CI automatically:

1. Builds, lints, typechecks, and tests all packages
2. Bumps versions of publishable packages based on commit type
3. Publishes **only packages whose source code changed**

| Commit type | Version bump |
|---|---|
| `feat:` | minor |
| `fix:`, `chore:`, etc. | patch |
| Breaking change (`!:`) | major |

## License

[MIT](LICENSE)
