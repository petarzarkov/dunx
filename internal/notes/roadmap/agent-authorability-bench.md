# Can an agent author a working app in this framework?

**Build it as a sixth bench family. The anchor is no framework at all, not NestJS.
Pilot 30 trials before committing to a sweep, because the sweep that can see a
20 point difference costs about $1,200.**

dunx has ten published workspaces, ~45k lines and no confirmed external user.
[docs/ROADMAP.md](../../../docs/ROADMAP.md), "Priority: the core three", names that as the
constraint and freezes peripheral surface until it changes. This file is the one kind
of work that constraint argues for: it produces evidence rather than surface, it lives
in `internal/` so it publishes nothing, and it measures the property dunx is already
designed around without ever having said so out loud.

That property is legible failure. `@dunx/transform` turns an erased constructor
parameter into a boot error naming the parameter, rather than an `undefined` that
surfaces four frames away. Every gate in `bun run ci` prints the fix. Those were
built for a human reading a terminal. The claim worth measuring is that they are worth
more to an agent, which cannot ask a colleague and which rewrites from scratch when
it cannot recover.

Nobody has measured this for any framework.

## What it measures

One trial is one agent, one task specification, one stack, a fresh empty directory
and a bounded budget. The outcome is a record, not a timing:

| Field                                  | From                                                            |
| -------------------------------------- | --------------------------------------------------------------- |
| `booted`                               | the app answers any request at all                              |
| `passed`                               | the acceptance suite is green                                   |
| `turns`, `tokens`, `costUsd`, `wallMs` | the runner's own JSON                                           |
| `firstFailure`                         | the taxonomy below, classified from the transcript              |
| `recovered`                            | whether the trial reached `passed` after hitting `firstFailure` |

The headline is a proportion: how often a stack produces a working app. Everything
else explains it.

## The anchor is no framework

`internal/bench/README.md` opens by saying the single most useful number the harness
produces is the gap between `@dunx/http` and raw `Bun.serve`, because dunx is a layer
over that exact API and the gap is therefore dunx's own overhead and nothing else.

The same move works here, and it is the reason to build this rather than a
dunx-versus-Nest chart. The anchor stack is `none`: the same task, `Bun.serve` and the
standard library, no framework to know. An agent writing that has no API to
hallucinate and no conventions to get wrong, so its pass rate is the floor that every
framework has to beat to justify existing. A framework that scores below the anchor is
costing the agent more than it saves it, and that is worth knowing whichever way it
comes out.

Against that floor, "dunx beats Nest" becomes a secondary result and a much less
interesting one.

## Stacks and conditions

| Stack  | Condition | What the agent gets                                            |
| ------ | --------- | -------------------------------------------------------------- |
| `none` | `cold`    | `Bun.serve` and the standard library                           |
| `dunx` | `cold`    | the model's own knowledge, no network                          |
| `dunx` | `docs`    | WebFetch to dunx.win, which serves `llms.txt` and raw chapters |
| `dunx` | `tooling` | the above plus `@dunx/mcp` and the scaffolded `AGENTS.md`      |
| `nest` | `cold`    | the model's own knowledge, no network                          |
| `nest` | `docs`    | WebFetch to docs.nestjs.com                                    |

Nest has no `tooling` row because no such thing exists for it. That asymmetry is a
result, not a flaw in the design: the `docs` to `tooling` delta is what `@dunx/mcp`
is worth, measured, and it is the only cell that answers whether shipping an MCP
server was a good use of the freeze exemption it was granted.

## Handicaps, in both directions

The bench README has a section called "Deliberate handicaps, in both directions"
because a comparison that hides them is not worth running. This harness has one that
dwarfs the rest.

**The model has read years of NestJS and months of dunx, at most.** Nest is in the
training corpus with a decade of Stack Overflow answers, tutorials and open source
behind it. dunx has a docs site and one repository. On the `cold` condition this is
close to the whole story, and a `cold` result that favours Nest says nothing about
either framework's design.

This is not correctable and must not be corrected for. Report it in the table header.
It cuts one way that helps the argument if dunx wins anyway, and it is the reason
`docs` and `tooling` are the interesting rows rather than `cold`.

Two smaller ones. dunx targets Bun and Nest does not, so the runtime is held at Bun
for dunx and Node for Nest, and any startup or install difference belongs to that
choice rather than to authorability. And the task specifications will be written by
whoever has dunx in their head, which biases word choice toward dunx's vocabulary; the
mitigation is that every spec is stated in HTTP terms (paths, status codes, JSON
shapes) and names no framework concept at all.

## The acceptance suite never imports the app

Each task ships a specification a human could implement and an acceptance suite that
talks to the finished app over HTTP and nothing else. No import, no test helper, no
knowledge of how the app is wired. This is `scenarios.ts` scaled up: that registry
already declares the exact status, body and MIME every subject must produce, and it is
what lets 18 subjects across 7 runtimes be compared at all.

Black box is what keeps the suite from favouring anybody's idioms, and it is also what
makes the anchor stack possible.

Four tasks, increasing in depth:

| Task        | Exercises                                                                                       |
| ----------- | ----------------------------------------------------------------------------------------------- |
| `crud`      | five REST routes over an in-memory store, one validated body, correct statuses                  |
| `wired`     | two services, one injected into the other, config validated from the environment, a 500 handler |
| `persisted` | the above over SQLite, with a migration and a health route                                      |
| `async`     | the above plus a background job and a server-sent event stream                                  |

`wired` is the discriminating one and should be the pilot's task. It is exactly where
an erased constructor parameter fires, which is exactly the claim under test.

## The taxonomy, which is the reason to build this

Classify the first failure of every trial:

| Class               | Means                                                 |
| ------------------- | ----------------------------------------------------- |
| `hallucinated-api`  | called a symbol the framework does not export         |
| `missing-preload`   | no `preload` line, so no constructor metadata (dunx)  |
| `erased-type`       | hit the erased-parameter boot error                   |
| `wrong-scope`       | bound in the wrong module, or never exported from one |
| `validation-misuse` | schema attached wrongly, or not at all                |
| `never-booted`      | the process never answered                            |
| `wrong-behaviour`   | booted, failed the suite                              |
| `budget-exhausted`  | ran out of turns still trying                         |

Then measure, per class, the share of trials that reached `passed` anyway. That is
error legibility, and it is a different quantity from the pass rate. An agent that
hits `erased-type` and fixes it is evidence that the boot error works. An agent that
hits it and thrashes is a defect report with a file and a line attached.

The pass rate is a number for a blog post. The taxonomy is a roadmap, and it keeps
paying out after the marketing question is settled. If `missing-preload` turns out to
be a third of dunx failures, the fix is in `@dunx/core`'s error path, not in the docs.

## This is a proportion, and proportions are expensive

`stats.ts`'s `spread()` gives median, min, max and stddev over continuous samples. It
cannot express "37 of 50 trials passed": the median of a 0/1 array is not a summary of
anything. `quality.ts`'s `badRate()` is the right shape, successes over attempts, but
it is framed as a disqualification predicate with a hard 0.1% floor rather than a
reportable rate.

So the harness needs a `tally` beside `spread`, about fifteen lines, returning
attempts, passes, rate and a Wilson interval. The interval is not decoration. At the
worst case of a true rate near 50%, the 95% half width on a single rate is:

| Trials per cell | Half width on one rate | Half width on a difference of two |
| --------------- | ---------------------- | --------------------------------- |
| 10              | ±31 points             | ±44 points                        |
| 20              | ±22 points             | ±31 points                        |
| 50              | ±14 points             | ±20 points                        |
| 100             | ±10 points             | ±14 points                        |

Reading that honestly: **ten trials per cell cannot distinguish anything.** Seeing a
20 point difference with any confidence takes about 100 trials per cell. That single
table is the most important thing in this file, because it is what separates a
benchmark from a screenshot of one lucky run, and it is the arithmetic that a
published agent comparison usually skips.

Two ways to buy resolution back. Pair by task rather than pooling, since task
difficulty is the dominant nuisance variable and a per-task difference has much lower
variance than a pooled one. And choose tasks that discriminate, because an effect of
40 points needs a quarter of the trials that an effect of 20 points does.

## Cost, measured rather than assumed

The runner is `claude -p --output-format json`, which already reports everything the
record needs. Probed on this machine against Opus 5:

```
{"is_error":false,"num_turns":1,"total_cost_usd":0.3644,
 "usage":{"cache_creation_input_tokens":36339,"output_tokens":4,...},
 "modelUsage":{"claude-opus-5[1m]":{"costUSD":0.3635,...}},
 "permission_denials":[],"duration_ms":2066,"result":"ok"}
```

Two things follow. **Every trial pays about 36k cache creation tokens before it does
any work**, which is the system prompt and the tool definitions, and on Opus at a one
hour TTL that alone is $0.36. And the accounting is per model as well as per trial,
so a trial's cost is recorded rather than estimated.

Published rates: Opus 5 is $5 and $25 per million in and out, Sonnet 5 is $2 and $10,
Haiku 4.5 is $1 and $5. Cache reads bill at a tenth, cache writes at 1.25x on the five
minute TTL. Modelling a `wired` trial at roughly 30 turns, 1.2M cache reads, 80k cache
writes and 30k output:

| Model    | Per trial | Pilot, 30 trials | Sweep, 1,200 trials |
| -------- | --------- | ---------------- | ------------------- |
| Opus 5   | ~$2.10    | ~$65             | ~$2,500             |
| Sonnet 5 | ~$0.85    | ~$25             | ~$1,000             |

Those per-trial figures are estimates with wide error bars and the pilot exists partly
to replace them with measurements. **Which model to sweep on is your call and it is a
real one**: Sonnet is roughly a third the price, Opus is the model most people asking
"can an agent write this" actually have pointed at their repository. Running the pilot
on both and reporting the pair is defensible and costs about $90.

## Cross sweep comparisons are invalid

The bench README's equivalent lesson is that run to run deltas are the machine, so
subjects are interleaved within one run and compared as a share of raw `Bun.serve`.
Here the machine is the model. A pass rate measured on one model on one date is not
comparable to one measured three months later, because the model changed underneath
it and dunx's presence in the corpus changed with it.

So: pin the exact model id and the date in the report header, and state every result
as a delta against the `none` anchor measured in the same sweep. A raw percentage with
no anchor and no model id is not a result.

## Where it plugs in

The existing harness has five report families and a documented contract for a sixth.
`db-modes.ts` is the closest template for the units and the loop, since its units are
not variations of the HTTP subject registry; `validation.ts` is the better model for
the reporting half, since its types live in `types.ts` and it has a real tables
module.

| File                       | Change                                                                                               |
| -------------------------- | ---------------------------------------------------------------------------------------------------- |
| `src/types.ts`             | `AgentUnit` and `AgentReport`, carrying `schemaVersion`, `generatedAt`, `machine`, `config`, `units` |
| `src/stats.ts`             | `tally()` beside `spread()`, with the Wilson interval                                                |
| `src/agent.ts`             | new. The unit list, the N trial loop, the spawn, the record, `Bun.write` to `results/agent.json`     |
| `src/agent-tables.ts`      | new. `agentSection(): Promise<string \| null>`                                                       |
| `src/readme-tables.ts`     | one more `replaceSection` call                                                                       |
| `internal/bench/README.md` | one `##` heading for it to target                                                                    |
| `package.json`             | one script                                                                                           |
| `.gitignore`               | `!results/agent.json` if the section must survive a clean checkout                                   |

Nothing in `run.ts`, `cli.ts`, `subject-process.ts`, `driver.ts`, `loadgen/`,
`toolchains.ts` or `build.ts` changes. Three things cannot be reused and it is worth
saying why: `driveUnits` is welded to a load generator with connections and a duration,
and an agent run has neither; `startSubject` polls a long lived server on `/plaintext`,
and an agent is a one shot process with an exit code; and the `Subject` type's required
`validator` and `io` fields are HTTP benchmark artifacts that `registry.test.ts` would
reject for a non-server entry.

Environment follows the existing convention, read inline with a default and documented
in the requirements table: `BENCH_AGENT_MODEL`, `BENCH_AGENT_TRIALS`,
`BENCH_AGENT_MAX_TURNS`.

Each trial runs in a fresh directory under `.bench-tmp/agent/` with
`--permission-mode bypassPermissions`, and the dunx checkout must be unreachable from
it. An agent that can read `packages/core/src` is not being asked the question this
harness asks. The `cold` condition denies WebFetch and WebSearch outright; whether
`docs` can be pinned to one host with a `WebFetch(domain:dunx.win)` permission rule is
unverified and the pilot should settle it before the sweep depends on it.

## The pilot, and the gate

One task (`wired`), three stacks (`none`, `dunx` at `tooling`, `nest` at `docs`), ten
trials each. Thirty trials, about $65 on Opus or $25 on Sonnet, and its job is not to
answer the question. Ten trials per cell cannot, per the table above.

Its job is to answer four cheaper questions: does the harness run unattended, does the
acceptance suite actually reject a broken app, what does a trial really cost, and how
big is the effect. That last one sizes the sweep, and it is also the gate.

**If the pilot's observed difference is under about 15 points, stop and do not fund the
sweep.** An effect that small needs several hundred trials per cell to establish and
will not convince anyone when it lands. The harness is still worth keeping at that
point, but as an internal regression detector on the taxonomy rather than as an
argument aimed outward: run it on a handful of trials per release and watch whether
`hallucinated-api` climbs after an API change.

That is the honest failure mode of this whole idea and it should be cheap to discover.

## What it does not measure

- **Whether the resulting app is any good.** The suite checks behaviour over HTTP.
  It says nothing about whether the code is maintainable, secure, idiomatic, or
  something a reviewer would accept.
- **Whether a human would be faster.** No human arm. The comparison is agent to agent
  across stacks, and nothing here argues that an agent should be writing the service.
- **Any model but the one in the header**, and any date but the one in the header.
- **Absolute rates.** Only the delta against the `none` anchor within one sweep.
- **Adoption.** An agent writing dunx correctly when instructed to is a different
  question from an agent, or a person, choosing dunx unprompted. This harness cannot
  see the second one at all, and that is the question the roadmap's constraint is
  actually about.
