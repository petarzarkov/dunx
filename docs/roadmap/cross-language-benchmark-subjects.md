# Cross-language benchmark subjects

**Done.** Gin, raw `net/http`, Axum, Spring Boot and Django are in the suite, and
`results/latest.json` is a full 16-subject run with every toolchain present. Kept
only for the reading it needs, which is the part that matters.

## What the run says

Plaintext, median req/s, deviations under 3% except where noted, **zero errors on
every subject in every scenario**:

| subject           | runtime | plaintext | validate |    startup |
| ----------------- | ------- | --------: | -------: | ---------: |
| `@dunx/http`      | Bun     |   137,539 |   75,769 |    54.8 ms |
| `Bun.serve` (raw) | Bun     |   136,940 |   89,047 |    28.7 ms |
| Elysia            | Bun     |   135,907 |   74,858 |    58.1 ms |
| **Axum**          | Rust    |   118,999 | _83,333_ | **1.5 ms** |
| **net/http**      | Go      |    75,510 |   46,748 |     3.9 ms |
| **Gin**           | Go      |    71,274 |   47,553 |     4.9 ms |
| **Spring Boot**   | JVM     |    46,956 |   31,394 | 1,276.5 ms |
| **Django**        | Python  |     4,387 |    3,882 |   134.2 ms |

## How to read it, which is the whole point of adding these

**`@dunx/http` came out 0.4% above raw `Bun.serve` on plaintext.** That is not a
framework beating the API it calls; it is noise, at deviations of 1.6% and 1.4%. The
harness has said "a figure at or above 100% is noise, not a win" since before these
subjects existed, and this is that rule earning its place.

**Every subject is one process on one thread.** For Bun and Node that is a fact about
the runtime. For Go, tokio and Tomcat it is a decision the harness imposes -
`GOMAXPROCS(1)`, a `current_thread` runtime, `tomcat.threads.max=1`. Lift it and
`net/http` goes to ~230,000 and Axum to ~503,000 at the same 64 connections, while
neither Bun subject can move at all. **These rows flatter Bun by exactly the factor
the reader is not shown**, which the bench README states on the row itself.

Axum being _ahead_ of dunx on `validate` while behind on plaintext is the honest
shape of it: pinned to one thread, Bun's HTTP core is competitive with tokio at
trivial work and loses once there is real work per request.

**Django's `validate` deviation is 15.7%**, above the 3% noise floor, so that one
figure should not be quoted as precise. And Django is on gunicorn with one worker:
`wsgiref` measured 317 req/s with 32 dropped connections, which would have been a
number about `wsgiref` rather than about Django.

## Left

Nothing blocking. If the cross-language rows are ever put on the landing page rather
than the benchmarks page, the one-thread caveat has to travel with them - without it
the chart says something about Go and Rust that is not true.
