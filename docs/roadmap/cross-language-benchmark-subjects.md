# Benchmark against Go, Java and Rust

**Open.** Requested after noticing what Elysia's own chart claims.

Elysia's landing page benchmarks against Gin (Go), Spring (Java) and Fastify, and
shows Elysia at 2,454,631 req/s against Gin's 676,019 and Spring's 506,087 -
TechEmpower Round 22, PlainText. The owner's reaction is the right one: **a
JavaScript runtime beating Go by 3.6x and Java by 4.8x on plaintext is not a
plausible framework result**, it is an artefact of what each entry is allowed to do
in that benchmark. TechEmpower PlainText entries differ enormously in how much they
bypass their own framework, and the top JS entries lean on `uWebSockets` and
pre-serialised responses.

So this is worth adding for two reasons, and the second is the better one:

1. It answers the question a reader actually has. "Faster than Express" is easy;
   "within a factor of Go" is the interesting claim.
2. **It is a falsification test on our own harness.** If dunx comes out ahead of
   Gin or Axum on this setup, that is evidence the harness is measuring something
   other than what it claims, not evidence dunx is faster than Go. A result that
   cannot embarrass us is not a measurement.

## Subjects to add

| Language | Framework       | Notes                                                                                                              |
| -------- | --------------- | ------------------------------------------------------------------------------------------------------------------ |
| Go       | **Gin**         | Matches Elysia's comparison. `net/http` as a raw floor is worth having too, mirroring `node:http` and `bun-serve`. |
| Rust     | **Axum**        | Requested. Tokio-based, the current default choice.                                                                |
| Java     | **Spring Boot** | Matches Elysia. The heaviest to add: a JVM, a build, and a warmup profile that makes JIT timing honest.            |

## What makes this harder than adding a Node subject

- **A toolchain per subject.** `tools/bench` currently needs only Bun and Node. Go,
  Rust and a JDK are three more, and CI has none of them. The likely answer is that
  cross-language subjects are opt-in locally and skipped in CI, the way the
  database and Redis tests already are.
- **Compilation is not startup.** The startup table measures cold process to first
  request. A Go or Rust binary is compiled ahead of time and a JVM is not, so the
  column needs either a build step excluded from the timing or a note saying what
  is being compared.
- **JIT warmup.** The JVM needs a longer warmup than 3 seconds to be measured
  fairly. Reporting Spring without that would be exactly the kind of flattering
  measurement this repo avoids, in the opposite direction.
- **The equivalence check still applies.** `tools/bench` rejects a subject whose
  response differs, which caught NestJS answering `text/html` and 201-on-POST. Each
  new subject has to answer byte-identically.

## What not to do

Do not quote TechEmpower figures alongside ours. The bench README already says these
numbers are a relative ranking on one machine with a shared loopback, and mixing in
someone else's dedicated-hardware run would produce a table that looks comparable
and is not. If TechEmpower is worth citing, cite it as a separate, clearly labelled
thing.
