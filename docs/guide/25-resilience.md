# Resilience

Timeout, retry, exponential backoff, jitter and fallback around one operation.
`ResiliencePolicy` lives in `@dunx/core`, has no dependency, and wraps anything
that returns a promise: an outbound call, a driver query, a broker publish.

There is no circuit breaker, no bulkhead and no rate limiter here. The last one
already exists in the other direction: `ThrottleModule` in `@dunx/http` is
inbound admission control, keyed by caller and backed by a shared store. Retrying
work this process owns is bullmq's, through `@dunx/infra/queue`.

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
  constructor(private readonly policy: ResiliencePolicy) {}

  charge(order: Order): Promise<Receipt> {
    return this.policy.run((signal) => this.gateway.charge(order, signal));
  }
}
```

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

`resiliencePolicy(name)` returns the same token for the same name. A subclass is
both a token and a parameter type, so prefer it for new code:

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

`RetryClassifier` answers that, and is an abstract class rather than an
interface, since an interface at an injection site is a boot error. The default
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

Bind `ResilienceModule` when the work is not a request that client makes.
