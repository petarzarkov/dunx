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
bun run dev       # http://localhost:3000/greetings, restarting on a change
```

## The questions

There is no flag for choosing features. The command opens a list:

```
? Features  2 chosen, 1 pulled in
  ○ notes       CRUD routes with zod validation. The smallest real feature.
  ◉ openapi     OpenAPI 3.1 from the routes own schemas, plus the Swagger UI page.
  ◈ database    drizzle over bun:sqlite, with a schema, seeds and migrations.
❯ ◉ users       A repository, a service and validated routes over the database.
  ○ auth        better-auth mounted, with SessionGuard and an audit trail.
  database comes along as a requirement.
  Space toggles. ↑↓ moves. a all, n none. Enter continues.
```

| Key             | Does                                          |
| --------------- | --------------------------------------------- |
| `↑` `↓`, `k` `j`, Tab | Move the cursor                         |
| Space           | Toggle the feature under it                   |
| `a` / `n`       | Everything / nothing                          |
| Enter           | Take the selection                            |
| Ctrl+C, Esc     | Stop, having written nothing                  |

`◉` is chosen, `◈` is pulled in by something else you chose, `○` is neither. The
two lines under the list update as you go: what your selection drags in, and which
of it needs Redis or Postgres running to do anything.

Three more questions appear only when there is something to ask: a directory, when
the command line named none; a package name, when the directory's is one npm would
reject; and whether to write into a directory that already has files in it.

## Options

| Flag            | Default            | Meaning                                       |
| --------------- | ------------------ | --------------------------------------------- |
| `--name <name>` | the directory name | Package name for the generated app            |
| `--force`       | off                | Write into a directory that already has files |
| `--yes`, `-y`   | off                | Skip the questions, take the minimal template |
| `--help`        |                    | Print usage                                   |

**Piped, redirected or in CI it asks nothing** and writes the minimal template, so
a script never hangs on a question nothing can answer. To choose features without
a terminal, call [`scaffold`](#programmatic-use) rather than passing flags.

The name is validated against npm's rules **before** anything is created, because
an invalid one would otherwise surface as a confusing `bun install` failure inside
a directory you just made.

## Scaffolding into a repo you already made

```bash
mkdir my-api && cd my-api && git init
bunx @dunx/create-app .
```

`.git`, `.gitkeep`, `.DS_Store` and `LICENSE` do not count as contents, so a fresh
repo or a clone of an empty GitHub repository is a valid target without a question.
Nothing else is ignored: `.gitignore` and `README.md` both come out of the template,
and overwriting your copy of either is what the last question asks about.

## What a composed app looks like

```
my-api/
  src/
    main.ts          exports createApp, and serves it when run directly
    app.module.ts    the root module, importing every feature
    config.ts        one validation function, flat env in and a shaped object out
    users/           one directory per feature you chose
  package.json       dev, start, test, typecheck
  bunfig.toml        the transform preload
```

Three files are generated for the selection and the feature directories are copied.
`main.ts` is one file rather than two: a test imports `createApp` from it, and the
`import.meta.main` block at the bottom is what stops that starting a server.

**There is no worker entry point, even with queues.** `QueueModule` is given
`consume: true`, so the container opens the bullmq workers at `onInit` and closes
them before the connections the handlers use. A handler marked `background: true` is
forked by bullmq itself into `src/jobs/jobs.processor.ts`.

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
  features: ['users', 'openapi'],
});
```

This is the scripted path the removed `--with` flag used to be. `features` takes
the same names the list shows, in any order, and pulls in what they require;
`FEATURES` exports the set. Omitting it writes the minimal template.

`scaffold` throws `ScaffoldError` for anything the caller can fix - an unknown
template, an unusable package name, a non-empty target without `force` - and lets
everything else propagate.
