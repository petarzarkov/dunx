# Anything else in @arkv worth integrating

**Open. Explicitly not a hard requirement.**

The owner maintains `@arkv/*` and plans to keep supporting it. CLAUDE.md already
makes three of them mandatory when the need arises, so this is about finding a need
rather than finding a package.

| package           | status in dunx                                                                                                                                                                                                                                              |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@arkv/logger`    | Used. `@dunx/infra/logger` binds it to core's `Logger` contract.                                                                                                                                                                                            |
| `@arkv/colors`    | Used, through the logger.                                                                                                                                                                                                                                   |
| `@arkv/timezones` | Mandated for any date or zone handling. No such need has arisen.                                                                                                                                                                                            |
| `@arkv/rng`       | Mandated for ids and sampling. dunx currently uses `Bun.randomUUIDv7` for the relay origin and `crypto.randomUUID` for request ids, both Bun-native and measured at 0.04 us. Switching would trade a native call for a dependency with no measured benefit. |

## What to actually do

Read the rest of the `@arkv` workspace and look for a need dunx already has and
solves worse. The bar is a real need, not a plausible one: CLAUDE.md's own rule is
that a half-built version of something mature is a liability, and the inverse also
holds - pulling in a dependency for a problem dunx does not have is weight for
nothing.

Two places dunx currently hand-rolls something small and might not want to:

- **Redaction.** `ConsoleLogger` deliberately does not sanitize, mask or rotate;
  that is the reason to swap in `@dunx/infra/logger`. If `@arkv` grows a standalone
  redaction utility, core's default could use it without taking the whole logger.
- **Backoff.** The relay's resubscribe and the queue's retry both implement
  doubling backoff separately. Neither is complicated; a shared one is only worth it
  if a third appears.

Improvements go into the `@arkv` repo and come back as a version bump, never a
local patch or a vendored copy.
