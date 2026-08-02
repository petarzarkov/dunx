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

## Django, added and measured but not published

`django` is in the subject registry and answers all four scenarios byte-identically.
Opt in with `BENCH_PYTHON` or `BENCH_PYTHONPATH`; the probe requires `import django`
to succeed, so a Python without it skips the row cleanly.

Measured standalone on this machine, 2 s per scenario, load average 1.2:

| scenario  | req/s |     p99 |
| --------- | ----: | ------: |
| plaintext | 4,562 | 15.0 ms |
| json      | 4,390 | 14.9 ms |
| params    | 4,347 | 15.4 ms |
| validate  | 4,086 | 17.0 ms |

Startup 134.0 ms (median of 7), which is the row where Django is furthest behind:
against `@dunx/http`'s ~53 ms and Axum's 1.5 ms, that is Python's import cost plus
gunicorn's fork.

**The server matters more than the framework here, and the first attempt proved
it.** On `wsgiref.simple_server` - the standard library's reference WSGI
implementation - the same app measured **317 req/s, p99 1.27 s, and 32 dropped
connections** at the harness's 64. That is a number about `wsgiref` serialising
connections, not about Django, and publishing it would have understated Django by a
factor of fourteen. The subject uses gunicorn with one worker instead, which is what
a Django deployment actually runs.

## What is still needed to publish any of it

One run on a machine with **all** the toolchains present. This one has Rust and
Python but no Go, JDK or Maven, so a full run here would drop the `gin`, `nethttp`
and `spring` rows from `results/latest.json` rather than add to them - worse than
leaving the file alone, which is what was done.

A single-subject run overwrites `results/latest.json` with just that subject. Worth
knowing before running one against the committed file; it was reverted here.
