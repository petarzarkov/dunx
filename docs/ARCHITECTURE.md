# Architecture

The design record: what was measured, what was rejected, and why. It exists so a
decision is not re-litigated. A constraint that was probed on real Bun should not
have to be re-derived from memory.

**Not a tutorial.** If you want to learn dunx, start with the
[Introduction](./guide/01-introduction.md). Each page below assumes you already
know what the thing being justified does.

One page per subject. Read the one you need.

## Read this first

[**Verified constraints**](./architecture/constraints.md) - what was probed on real
Bun, and what each result rules out. Every other page rests on it. A decision that
contradicts it is a decision made without measuring.

## The framework

| Page                                                           | What it settles                                                                                     |
| -------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| [Dependency injection](./architecture/dependency-injection.md) | The decorator dialect, recording constructor types without metadata, and the scope each module gets |
| [The HTTP layer](./architecture/http.md)                       | The `Bun.serve` adapter, route discovery, and multi-node websocket fan-out                          |

## The integrations

Five areas are a mature library wired in rather than dunx code. This is the second
half of the principle above: **never reimplement what Bun does, never invent what a
mature library already solves.** None of them restates the library's own surface.

| Page                                               | Library                                        |
| -------------------------------------------------- | ---------------------------------------------- |
| [The database layer](./architecture/database.md)   | drizzle, over Bun's own SQLite and SQL drivers |
| [Authentication](./architecture/authentication.md) | better-auth                                    |
| [Queues](./architecture/queues.md)                 | bullmq, over `Bun.RedisClient`                 |
| [Logging](./architecture/logging.md)               | `@arkv/logger`, and where a fix belongs        |

The fifth is **swagger-ui-dist**, which `@dunx/openapi` mounts for its `/docs` page.
It is written up with the tooling rather than here: what it replaced was a frontend
of dunx's own. See [The tools](./architecture/tooling.md), "The API explorer".

## Shipping it

| Page                                                  | What it settles                                                                     |
| ----------------------------------------------------- | ----------------------------------------------------------------------------------- |
| [Building and releasing](./architecture/packaging.md) | The topological build, why versioning is lockstep, and what the scaffolder resolves |
| [The tools](./architecture/tooling.md)                | The documentation site, and why the API explorer became swagger-ui-dist             |
| [The MCP server](./architecture/mcp.md)               | What an agent may read out of an app, and why it never boots one                    |

## What was measured

The harness exists to attribute costs, not to win. Its own README says these are a
relative ranking on one machine.

| Page                                                                   | Finding                                                                     |
| ---------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| [The benchmark harness](./architecture/benchmarks.md)                  | How subjects are made comparable, and what the harness refuses to do        |
| [The cost of request validation](./architecture/cost-of-validation.md) | Reading the body costs roughly three times as much as validating it         |
| [The cost of request logging](./architecture/cost-of-logging.md)       | Where the 4.78 us goes, and why one `write(2)` per entry is the worst of it |

## What is not here

- **What to build next** is [ROADMAP.md](./ROADMAP.md), with one file per open item
  under [`internal/notes/roadmap/`](../internal/notes/roadmap/). The phase plan used
  to be in this file. It now lives there, with the rest of the planning.
- **Whether something can be built at all**, with the probe output behind the answer,
  is [`internal/notes/research/`](../internal/notes/research/) - one file per
  investigated capability, written to be superseded. The pipeline runs research,
  then roadmap, then here: a measurement arrives in `research/`, an accepted item
  becomes a `roadmap/` file, and what survives delivery lands in `architecture/`.
  [research/README.md](../internal/notes/research/README.md) holds the verdict
  table.
- **The rules a change has to satisfy** are in `CLAUDE.md` at the repo root. This
  file records decisions; that one constrains them.
- **How to contribute** is [CONTRIBUTING.md](../CONTRIBUTING.md).
