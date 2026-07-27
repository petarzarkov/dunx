Run all CI checks for this repo in order. Stop and report on the first failure.

1. **Build** — `bun run build`
2. **Lint** — `bun run lint`
3. **Typecheck** — `bun run typecheck`
4. **Test** — `bun run test`

Run each command using the Bash tool in that order - build needs to be before all else. After all pass, confirm with a brief summary of results.
