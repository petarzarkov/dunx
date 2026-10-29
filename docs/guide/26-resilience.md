# Resilience

Timeout, retry, exponential backoff, jitter and fallback around one operation,
with an optional circuit breaker and bulkhead. `ResiliencePolicy` lives in
`@dunx/core`, has no dependency, and wraps anything that returns a promise: an
outbound call, a driver query, a broker publish.

There is no rate limiter. For related needs:

| Need                                     | Use                                                                           |
| ---------------------------------------- | ----------------------------------------------------------------------------- |
| Limit incoming requests per caller       | `ThrottleModule` in `@dunx/http`, with a shared store                         |
| Retry background work this process owns  | bullmq, through `@dunx/infra/queue`                                           |
| Accept a client's retried request safely | `@Idempotent()`, see [Idempotency](./33-idempotency.md)                       |
| Bound a slow route handler               | `timeoutMs` and `retry` on the calls it makes, and `signal: input.req.signal` |

A route handler is not wrapped in a policy:

- Its body is read once, so a second attempt would find it consumed.
- A retry would run the guards and every side effect again.
- A timeout only stops work that takes a signal, and a handler is not given one.

The slow part is a call the handler makes, so the budget goes there.
`HttpService` takes `timeoutMs`, `retry` and `signal` per call, and
`input.req.signal` aborts when the client hangs up.

## Binding a policy

```ts
import { ResilienceModule } from '@dunx/core';

@Module({
  imports: [
    ResilienceModule.forRoot({
      timeoutMs: 3_000,
      retry: { maxRetries: 3, retryDelayMs: 200 },
    }),
  ],
})
export class PaymentsModule {}
```

That binds `ResiliencePolicy` and `ResilienceOptions`. `run` takes the operation
and hands it the signal for its attempt:

```ts
export class Checkout {
  constructor(
    private readonly policy: ResiliencePolicy,
    private readonly gateway: PaymentGateway,
  ) {}

  charge(order: Order): Promise<Receipt> {
    // `order.id` as the idempotency key: see the warning below.
    return this.policy.run((signal) => this.gateway.charge(order, signal));
  }
}
```

**Retry only what is safe to run twice.** A transport failure can arrive after
the upstream already did the work, and a retry then does it again. For a charge
that is a second charge. Send an idempotency key the upstream honours, or narrow
the classifier so only a failure that cannot have landed is retried: a connect
error or a 503 with no body, rather than every timeout.

`maxRetries` counts retries after the first attempt, so `3` is up to four calls.
`timeoutMs` is per attempt and `0` leaves each one unbounded. The signal is
`AbortSignal.timeout` combined with any signal passed in `signal`, through
`AbortSignal.any`; an operation that ignores it still runs to completion, and
only a `fetch` or a `throwIfAborted()` makes the budget real.

## Two policies, and one that is a constructor parameter

A second `forRoot` binds its own options token, so two budgets do not collide:

```ts
ResilienceModule.forRoot({ name: 'payment', timeoutMs: 3_000 });
ResilienceModule.forRoot({ name: 'search', timeoutMs: 400 });
```

A name binds a `Token`, which is reached with `inject()` in a field:

```ts
export class Checkout {
  readonly payment = inject(resiliencePolicy('payment'));
}
```

`resiliencePolicy(name)` returns the same token for the same name. For new code,
prefer a subclass: it works as a token and as a constructor parameter type:

```ts
export class PaymentPolicy extends ResiliencePolicy {}

ResilienceModule.forRoot({ timeoutMs: 3_000 }, PaymentPolicy);

export class Checkout {
  constructor(private readonly policy: PaymentPolicy) {}
}
```

Either form leaves `ResiliencePolicy` itself unbound, so a default policy and
several named ones coexist.

`forRootAsync` takes the same `{ useFactory, inject, imports }` every other dunx
module does, for a budget that comes off `ConfigService`:

```ts
ResilienceModule.forRootAsync({
  useFactory: (config: AppConfigService) => ({
    timeoutMs: config.get('upstream').timeoutMs,
  }),
  inject: [AppConfigService] as const,
});
```

## Deciding what is worth retrying

`RetryClassifier` decides. It is an abstract class because a constructor can only inject something that exists at runtime, and an interface does not.
The default
is `TransientRetryClassifier`: everything is retried except an abort, which means
the attempt's timeout expired or the caller's signal fired.

`@dunx/http/client` ships `HttpRetryClassifier` for HTTP work. It retries 408,
429 and 5xx, refuses the rest, and reads `Retry-After` in both spellings RFC 9110
allows, seconds and an HTTP date:

```ts
import { HttpRetryClassifier } from '@dunx/http/client';

ResilienceModule.forRoot({
  timeoutMs: 3_000,
  classifier: new HttpRetryClassifier(),
  retry: { maxRetries: 3, retryDelayMs: 200 },
});
```

A 409 or a 422 is the server rejecting the request, and sending it again
unchanged gets the same answer, so neither is retried. Pass
`shouldRetryOnStatus` to widen or narrow that, and `respectRetryAfter: false` to
use the computed backoff instead of what the upstream asked for.

Writing one is a `classify` that returns a verdict:

```ts
export class DbRetryClassifier extends RetryClassifier {
  classify(error: unknown): RetryVerdict {
    return { retry: error instanceof DeadlockError };
  }
}
```

`delayMs` on the verdict overrides the computed backoff for that attempt, capped
by `backoff.maxMs`, which is what keeps an upstream asking for an hour from
parking a request handler for an hour.

## Backoff and jitter

The wait before retry `n` is `retryDelayMs * power ** n + jitter`, capped at
`maxMs`:

```ts
ResilienceModule.forRoot({
  retry: {
    maxRetries: 4,
    retryDelayMs: 200,
    backoff: { power: 2, jitterMs: 250, maxMs: 5_000 },
  },
});
```

Defaults are `power: 2`, `jitterMs: 1000` and `maxMs: 30000`. The jitter comes
from `crypto.getRandomValues`, not `Math.random`: decorrelating a fleet of
clients retrying together is the whole job.

`onAttempt`, `onError` and `onSuccess` report the loop without wrapping it:

```ts
ResilienceModule.forRoot({
  retry: {
    onAttempt: (attempt, isRetry) => log.debug({ attempt, isRetry }),
    onError: (error, attempt, willRetry) => log.warn({ attempt, willRetry }),
  },
});
```

## Answering with something when the attempts are spent

`fallback` receives the last error and its value becomes the call's result:

```ts
ResilienceModule.forRoot({
  retry: { maxRetries: 2 },
  fallback: () => ({ cached: true, items: [] }),
});
```

It may be async, and it may throw, which replaces the failure rather than
suppressing it. Without a `fallback` the last error is rethrown.

## Stopping calls to a dependency that keeps failing

A `CircuitBreaker` counts consecutive failed attempts and opens at
`failureThreshold`. While open, every attempt is refused with a
`CircuitOpenError` without running. After `openMs` it lets `halfOpenProbes`
attempts through: one that resolves closes it, and one that fails opens it again.

```ts
import { CircuitBreaker, ResilienceModule } from '@dunx/core';
import { FetchError } from '@dunx/http/client';

ResilienceModule.forRoot({
  retry: { maxRetries: 3 },
  breaker: new CircuitBreaker({
    failureThreshold: 5,
    openMs: 30_000,
    isFailure: (error) => !(error instanceof FetchError) || error.status >= 500,
    onStateChange: (to, from) => log.warn({ breaker: to, from }),
  }),
  fallback: () => ({ cached: true }),
});
```

The breaker is an instance rather than options because its state has to outlive
a policy. Build one per dependency and pass it to every policy that calls that
dependency, including policies built per call.

- **The retry loop sits outside the breaker.** The attempt after the one that
  opened the circuit is refused, so a retry loop does not keep calling a
  dependency the breaker has given up on.
- **`isFailure` decides what counts.** An error it declines leaves the circuit
  as it is. The default counts everything except an `AbortError`, which is the
  caller giving up. A `TimeoutError` counts.
- **The state is per process.** Each replica opens on its own failures. Keeping
  it in Redis would put a network call in front of every attempt, during the
  outage the breaker exists for.

`fallback` answers a `CircuitOpenError` like any other failure. Without one, the
error is raised, and it carries `status: 503`.

## Capping concurrent calls

A `Bulkhead` limits how many calls run at once, so a slow dependency cannot hold
every connection in the process:

```ts
import { Bulkhead, ResilienceModule } from '@dunx/core';

ResilienceModule.forRoot({
  timeoutMs: 2_000,
  bulkhead: new Bulkhead({ maxConcurrent: 10, maxQueued: 20 }),
});
```

A call holds one slot from start to finish, retries and backoff included. Past
`maxConcurrent` it waits in arrival order, and past `maxQueued` it is rejected
with a `BulkheadRejectedError` (`status: 503`), which `fallback` answers like any
other failure.

`maxQueued` defaults to `0`, which rejects as soon as the slots are full. A
waiting call gives up when the policy's `signal` aborts, and the slot is
released however the call ends.

Like the breaker, a bulkhead is an instance shared by the policies that should
count against one cap, and it is per process: it protects this process's sockets
and memory.

## The outbound client already uses one

`HttpService` in `@dunx/http/client` builds a policy per call from its own
`timeoutMs` and `retry`, with `HttpRetryClassifier`, so an app calling out
through it gets all of this without binding a module:

```ts
HttpModule.forRoot({
  baseUrl: 'https://api.upstream.test',
  timeoutMs: 3_000,
  retry: { maxRetries: 3, retryDelayMs: 200, backoff: { maxMs: 2_000 } },
});
```

You need `ResilienceModule` only for work that does not go through `HttpService`.
If you wrap an `HttpService` call in your own policy, pass the attempt's `signal`
to the request. Otherwise the policy's `timeoutMs` never reaches `fetch`:

```ts
policy.run((signal) => this.http.get(url, { signal }));
```
