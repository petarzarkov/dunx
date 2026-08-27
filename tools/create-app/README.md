# @dunx/create-app

Scaffolds a new [dunx](https://github.com/petarzarkov/dunx) application.

```bash
bunx @dunx/create-app my-api
```

> `bun create dunx-app` does **not** work and is not advertised:
> `bun create <template>` resolves the unscoped npm package
> `create-<template>`, which this package - being scoped - is not.

```
cd my-api
bun install
bun run start     # http://localhost:3000/greetings
```

## Options

| Flag                | Default            | Meaning                                            |
| ------------------- | ------------------ | -------------------------------------------------- |
| `--name <name>`     | the directory name | Package name for the generated app                 |
| `--with <a,b,c>`    |                    | Features to compose the app from                   |
| `--all`             | off                | Every feature                                      |
| `--list`            |                    | Print the features and exit                        |
| `--template <name>` | `minimal`          | Which template to write                            |
| `--force`           | off                | Write into a directory that already has files      |
| `--yes`, `-y`       | off                | Take the minimal template without prompting        |
| `--help`            |                    | Print usage                                        |

With neither `--with` nor `--yes`, and a terminal attached, it lists the features
and reads one line of stdin. Piped or in CI it never prompts, so **an agent or a
script should pass `--yes` or `--with`**.

The name is validated against npm's rules **before** anything is created, because
an invalid one would otherwise surface as a confusing `bun install` failure inside
a directory you just made.

## Scaffolding into a repo you already made

```bash
mkdir my-api && cd my-api && git init
bunx @dunx/create-app .
```

`.git`, `.gitkeep`, `.DS_Store` and `LICENSE` do not count as contents, so a fresh
repo or a clone of an empty GitHub repository is a valid target without `--force`.
Nothing else is ignored: `.gitignore` and `README.md` both come out of the template,
and overwriting your copy of either is what `--force` is there to ask about.

## What it generates

The `minimal` template, the same app as
[`examples/minimal`](https://github.com/petarzarkov/dunx/tree/main/examples/minimal) a service, a controller, a module, `HttpFactory.create`, one test against a real
server, and the `bunfig.toml` preload line that makes constructor injection work.

Its `src/` is a **byte-for-byte copy** of that example, and a test in this package
fails if the two ever drift.

Every app also gets an `AGENTS.md` naming its layout, its commands and the rules
dunx fails at boot over, plus a `CLAUDE.md` pointing at it. Both link
<https://petarzarkov.github.io/dunx/setup.md>, which is served per release, rather
than copying the framework's own instructions into your repository. The example is the one CI boots, so keeping them
identical is what makes the template trustworthy rather than merely plausible.

## Two details

**Versions are resolved at run time rather than written into the template.** Every
`@dunx/*` range in the template manifest is `__DUNX_VERSION__`, replaced with a
caret range on this package's own version. dunx versions in lockstep - every
package shares one number and ships together - so the version doing the
scaffolding is by definition a set that works together.

Writing versions into the template would go stale on the next release.

Keep it that way when you add a package later. The packages peer-depend on each
other by caret range, so mixing minors warns on install - and can leave two copies
of `@dunx/core` in one tree, which breaks dependency injection outright: a token
*is* a class object, so two copies are two different classes and a provider bound
against one is invisible to the other.

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

`scaffold` throws `ScaffoldError` for anything the caller can fix - an unknown
template, an unusable package name, a non-empty target without `force` - and lets
everything else propagate.
