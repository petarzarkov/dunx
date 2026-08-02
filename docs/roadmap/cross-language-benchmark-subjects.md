# Publish the cross-language benchmark numbers

**Mostly delivered.** Gin, raw `net/http`, Axum and Spring Boot are subjects in
`tools/bench`, opt-in per toolchain, skipped cleanly when it is absent, contract
checked, compiled outside the startup timing and with the JVM warmed for 30 s.
The design work and every caveat are recorded in `tools/bench/README.md`.

**What is left is one clean run.** `results/latest.json` predates them, and every
table in that README is generated from it rather than typed, so the rows do not
appear until a full `bun run start` is taken on an idle machine and
`bun src/readme-tables.ts` regenerates the sections. The run needs Go, Cargo and
a JDK plus Maven present; without them the suite silently produces the old
eleven-subject table, which is correct but is not the point.

## What the falsification test found, so the rerun is read properly

The item existed to embarrass the harness if the harness deserved it. It half
did.

- **The harness is not client-capped.** The obvious failure mode was that
  `bun-serve`, `dunx` and `axum` all clustering near 130k req/s meant oha at 64
  connections could not go faster. Rebuilding Axum on a multi-threaded tokio
  runtime and driving it with one oha at the same 64 connections answered
  ~503k req/s, so there is about 4x headroom and the top of the table is the
  server's number. That check is now in the README under "Load generator".
- **The framing is the problem, not the measurement.** Every subject is one
  process on one thread, which is a fact about Bun and Node and a _decision_
  imposed on Go, tokio and Tomcat. Under it, `@dunx/http` does come out ahead of
  Gin and level with Axum on `plaintext` and `json`. Lift the pin and raw
  `net/http` goes from ~73k to ~230k req/s and Axum from ~121k to ~503k at the
  same connection count, while neither Bun subject can move at all. Axum already
  wins `validate` even pinned.

So the honest one-line reading of these rows is "per thread, Bun's HTTP server
core is competitive with tokio and ahead of Go's" - and not one word more than
that. The README says so at length; the numbers should not be published anywhere
that paragraph does not travel with them.
