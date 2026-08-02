# The aggregate suite exits 1 while reporting zero failures

**Identified, not yet fixed.**

`bun run test` occasionally exits 1 with every per-workspace summary reading
`0 fail`. It was recorded as unreproduced; the cause has since been found.

`packages/openapi/src/page-ui.test.ts` intermittently, roughly one run in ten,
emits between tests:

```
ReferenceError: window is not defined
```

That exits `bun test` non-zero while the suite still reports `72 pass / 0 fail`.
Reproduced with unrelated new test files excluded, so it is the file itself and not
a scheduling interaction.

The file boots the real OpenAPI explorer bundle inside happy-dom to assert it makes
zero fetches during boot. `happydom.ts` registers the globals, so the likely shape
is a teardown race: something the bundle scheduled - a microtask, a timer, an
observer callback - runs after the globals are torn down, and by then `window` is
gone.

## Why it matters more than the flake itself

**A workspace that bails prints neither a pass count nor a fail count.** Any grep
for `N fail` misses it entirely, which is how this went unnoticed: the aggregate
output looked clean and only the exit code disagreed. Check exit codes, not output.

## What to try

- Have the test await whatever the bundle scheduled before the suite tears the
  globals down, rather than letting boot finish asynchronously.
- Keep the globals registered for the process lifetime instead of per file.
- If neither lands, at minimum make the failure name the file: an exit code with no
  failing test is worse than a red test.
