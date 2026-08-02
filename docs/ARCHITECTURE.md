# Architecture

The design record: what was measured, what was rejected, and why. It exists so a
decision is not re-litigated, and so a constraint that was probed on real Bun is not
re-derived from memory.

**Not a tutorial.** If you want to learn dunx, start with the
[Introduction](./guide/01-introduction.md); each page below assumes you already
know what the thing being justified does.

One page per subject. Read the one you need.

## Read this first

[**Verified constraints**](./architecture/constraints.md) - what was probed on real
Bun, and what each result rules out. Every other page rests on it, and a decision
that contradicts it is a decision made without measuring.

## The framework

| Page                                                           | What it settles                                                                                         |
| -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| [Dependency injection](./architecture/dependency-injection.md) | The decorator dialect, recording constructor types without metadata, and why modules do not encapsulate |
| [The HTTP layer](./architecture/http.md)                       | The `Bun.serve` adapter, route discovery, and multi-node websocket fan-out                              |

## The integrations

Three areas are a mature library wired in rather than dunx code, which is the second
half of Rule 1. None of them restates the library's own surface.

| Page                                               | Library                                        |
| -------------------------------------------------- | ---------------------------------------------- |
| [The database layer](./architecture/database.md)   | drizzle, over Bun's own SQLite and SQL drivers |
| [Authentication](./architecture/authentication.md) | better-auth                                    |
| [Queues](./architecture/queues.md)                 | bullmq, over `Bun.RedisClient`                 |
| [Logging](./architecture/logging.md)               | `@arkv/logger`, and where a fix belongs        |

## Shipping it

| Page                                                  | What it settles                                                                     |
| ----------------------------------------------------- | ----------------------------------------------------------------------------------- |
| [Building and releasing](./architecture/packaging.md) | The topological build, why versioning is lockstep, and what the scaffolder resolves |
| [The tools](./architecture/tooling.md)                | The documentation site and the API explorer                                         |

## What was measured

The harness exists to attribute costs, not to win. Its own README says these are a
relative ranking on one machine.

| Page                                                                   | Finding                                                                      |
| ---------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| [The benchmark harness](./architecture/benchmarks.md)                  | How subjects are made comparable, and what the harness refuses to do         |
| [The cost of request validation](./architecture/cost-of-validation.md) | Reading the body costs roughly three times as much as validating it          |
| [The cost of request logging](./architecture/cost-of-logging.md)       | Where the 5.38 us goes, and why one `write(2)` per entry was the worst of it |

## What is not here

- **What to build next** is [ROADMAP.md](./ROADMAP.md), with one file per open item
  under [`docs/roadmap/`](./roadmap/). The phase plan used to be in this file and is
  now there, where the rest of the planning already was.
- **The rules a change has to satisfy** are in `CLAUDE.md` at the repo root. This
  file records decisions; that one constrains them.
- **How to contribute** is [CONTRIBUTING.md](../CONTRIBUTING.md).
