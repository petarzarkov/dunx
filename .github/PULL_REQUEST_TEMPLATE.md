## What changed

<!-- One or two sentences. What does this do that the repo did not do before? -->

## Why

<!-- The problem, the issue number, or the decision this follows from. If it
reverses something recorded in docs/ARCHITECTURE.md, say so and link the section. -->

## Measurements

<!-- Required if this claims a performance change, optional otherwise.
Give the command, the machine, and before/after numbers with their standard
deviation. A result inside the noise is "no measurable difference", not a win.
Delete this section if the change is not performance-related. -->

## Checks

- [ ] `bun run build`
- [ ] `bun run lint:check`
- [ ] `bun run format:check`
- [ ] `bun run typecheck`
- [ ] `bun run test:cov`
- [ ] Tests cover the change. A bug fix has a test that fails without the fix.
- [ ] Conventional commit messages (`feat:`, `fix:`, `docs:`, ...).
- [ ] No em or en dashes. No `enum`, no `any`, no `Dunx`-prefixed identifiers.
- [ ] New runtime dependency? It satisfies Rule 1 in
      [CONTRIBUTING.md](../CONTRIBUTING.md), and any sanctioned integration is a
      `peerDependency`.
- [ ] Docs updated if the public surface changed (`docs/guide/`, package README).
