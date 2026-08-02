# @dunx/create-app

Scaffolds a new [dunx](https://github.com/petarzarkov/dunx) application.

```bash
bunx @dunx/create-app my-api
```

> `bun create dunx-app` does **not** work, and deliberately is not advertised:
> `bun create <template>` resolves the unscoped npm package
> `create-<template>`, which this package — being scoped — is not.

```
cd my-api
bun install
bun run start     # http://localhost:3000/greetings
```

## Options

| Flag                | Default            | Meaning                                            |
| ------------------- | ------------------ | -------------------------------------------------- |
| `--name <name>`     | the directory name | Package name for the generated app                 |
| `--template <name>` | `minimal`          | Which template to write                            |
| `--force`           | off                | Write into a directory that already has files      |
| `--help`            |                    | Print usage                                        |

The name is validated against npm's rules **before** anything is created, because
an invalid one would otherwise surface as a confusing `bun install` failure inside
a directory you just made.

## What it generates

The `minimal` template, which is the same app as
[`examples/minimal`](https://github.com/petarzarkov/dunx/tree/main/examples/minimal)
— a service, a controller, a module, `HttpFactory.create`, one test against a real
server, and the `bunfig.toml` preload line that makes constructor injection work.

Its `src/` is a **byte-for-byte copy** of that example, and a test in this package
fails if the two ever drift. The example is the one CI boots, so keeping them
identical is what makes the template trustworthy rather than merely plausible.

## Two details worth knowing

**Versions are resolved at run time, not written into the template.** Every
`@dunx/*` range in the template manifest is `__DUNX_VERSION__`, replaced with a
caret range on this package's own version. dunx versions in lockstep — every
package shares one number and ships together — so the version doing the
scaffolding is by definition a set that works together. Writing versions into the
template would go stale on the next release.

**The template's `.gitignore` ships as `_gitignore`.** npm renames a published
`.gitignore` to `.npmignore`, which would leave every scaffolded app without one.
The scaffolder puts the dot back on write.

## Programmatic use

```ts
import { scaffold } from '@dunx/create-app';

const { directory, files } = await scaffold({
  target: 'my-api',
  name: '@acme/my-api',
});
```

`scaffold` throws `ScaffoldError` for anything the caller can fix — an unknown
template, an unusable package name, a non-empty target without `force` — and lets
everything else propagate.
