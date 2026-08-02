# No trailing-slash normalisation

**Low. Possibly working as intended, but undocumented.**

`GET /t` is 200 and `GET /t/` is 404. Same for `/t/sub/` and `POST /t/`.

`Bun.serve({ routes })` owns matching, and "do not write a JavaScript router" is a
load-bearing rule, so declining to normalise is defensible. But Nest, Express and
Fastify all normalise, so **every ported client breaks on it**, and the failure is a
404 that looks like a missing route rather than a slash.

Cheapest honest fix is one line in guide 05 saying paths are matched exactly. If
normalisation is wanted, it belongs in the `fetch` fallback that already handles
unmatched paths, where Bun has already finished matching - not in a router.
