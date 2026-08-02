# A process that touched a down Redis will not exit on SIGTERM

**Open. Measured, and not reachable from userland.**

A process that attempted a queue operation while Redis was unreachable does not
exit on `SIGTERM`. bullmq holds a connection whose retry timer outlives `close()`,
and nothing in userland can reach that timer.

Bounded: importing the module is not enough, it takes an _attempted operation_, and
a healthy Redis is unaffected. Serving is unaffected. It is a shutdown defect only.
The measured table is in [bun-apis.md](../bun-apis.md).

This was mis-recorded once as "Redis never reachable" and corrected after
re-testing showed the trigger is the attempt, not the state. Do not re-narrow it
without re-measuring.

## Options

- Bound the connection harder at construction. `@dunx/infra/queue` already passes
  `connectionTimeout` and `maxRetries: 0` to its own `Bun.RedisClient`, which is
  what turned an enqueue hang into a 503 in 5.7 ms. bullmq's internal client is a
  different object and takes its own options.
- Report it upstream to bullmq with the reproduction.
- Document it as a deployment note, which
  [17-deployment.md](../guide/17-deployment.md) already does: set a grace period
  short enough that `SIGKILL` arrives promptly if workers run against a Redis that
  may be down at deploy time.
