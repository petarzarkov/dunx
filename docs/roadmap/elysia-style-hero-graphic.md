# An Elysia-style hero benchmark graphic

**Asked for twice. Not started.**

Elysia's site leads with a panel: two enormous gradient multipliers ("21x faster
than Express", "6x faster than Fastify") beside a horizontal bar chart of
frameworks with a runtime label on each.

## What our own numbers support

From the committed run in `tools/bench/results/latest.json`, plaintext, dunx at
135,442 req/s:

| against          | their rps |  multiple |
| ---------------- | --------: | --------: |
| NestJS (Express) |     9,918 | **13.7x** |
| Express          |    12,484 | **10.8x** |
| NestJS (Fastify) |    38,946 |      3.5x |
| Fastify          |    48,547 |  **2.8x** |
| Hono (Node)      |    46,165 |      2.9x |
| node:http        |    51,481 |      2.6x |
| Hono (Bun)       |   105,194 |      1.3x |
| Elysia           |   132,503 |      1.0x |
| Bun.serve        |   138,507 |      1.0x |

## The constraint that makes this harder than it looks

Elysia's figures are TechEmpower Round 22 on dedicated hardware. Ours are
same-machine over loopback with the load generator competing for the same cores,
which the bench README already says produces a relative ranking and not a capacity
number. The two are not comparable, and quoting theirs would be borrowing a
measurement we did not make.

Worse, the honest comparison is muddier than the graphic wants to be: **dunx runs
on Bun and Nest runs on Node**, so 13.7x is a runtime difference and a framework
difference multiplied together. The bench README already carries that caveat and
the graphic has to as well, or it becomes the misleading thing this repo spends
its effort avoiding.

## What to build

A component reading `bench.json` rather than hardcoded numbers, so a rerun moves
it. Two headline multiples against Node frameworks, bars coloured by runtime,
and the caveat next to it rather than under a fold. `BenchBars` already colours by
runtime and is the place to start.
