# One unexplained aggregate test failure

**Open. Not reproduced.**

`bun run test` exited 1 once. Immediately afterwards it passed three times, and
every workspace passed individually with no change in between. No failing test was
ever named in the output; the per-workspace summaries all read `0 fail`.

Most likely the Redis-backed queue or relay tests, since Redis is live on this
machine and those are the only tests with a real external service and real timing.
The benchmark and example suites also bind ports, which is another source of
cross-run interference when several run at once.

Recorded rather than fixed because nothing was identified. If it recurs, the thing
to capture is the full output rather than the summary lines: the aggregate runner
prints a per-workspace `Exited with code N`, and a workspace that bails prints
neither a pass count nor a fail count, so a grep for `N fail` misses it entirely.
That is how it went unnoticed the first time.
