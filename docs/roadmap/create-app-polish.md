# Four @dunx/create-app findings

## It refuses a directory containing only `.git`

**Bug. The one that actually blocks a flow.** `bunx @dunx/create-app .` in a fresh
`git init` repo exits 1:

```
... is not empty. Pass --force to write into it anyway.
```

Every comparable scaffolder ignores `.git`. This blocks "create the repo, then
scaffold into it", which is the documented way to start. The emptiness check should
ignore `.git` - and probably `.gitkeep`, `.DS_Store` and `LICENSE` too.

## Cosmetics when the target is `.`

Prints `Created dunx-template in ./` and `cd .`. Both should collapse to something
that reads correctly in place.

## `--yes` is rejected

`TypeError: Unknown option '--yes'`. The tool is fully non-interactive, so `--yes`
could be accepted as a no-op rather than an error - it is what a user reaches for
out of habit.

## `dist/scaffold.d.ts` ships with no `dist/scaffold.js`

Harmless: `index.js` is bundled and `index.d.ts`'s `./scaffold.js` specifier
resolves to the `.d.ts`. But it is a stray file the build should not emit.
