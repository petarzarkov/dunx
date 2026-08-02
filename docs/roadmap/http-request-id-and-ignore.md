# Three request-logging findings

## `requestLogging.ignore` also disables request-id and the async context

**Bug or documentation error. Medium.**

Guide 12 says the request id is "always set on the response". It is emitted by
`RequestLoggingMiddleware`, so an ignored path has no `x-request-id` **and** no
`AsyncLocalStorage` scope, so anything the handler logs is uncorrelated too.

```
ignored path      -> no x-request-id
non-ignored path  -> x-request-id: da291b81-...
```

`ignore`'s own doc says "paths to skip entirely - a health check polled every
second, say", which does not say correlation goes with it. **"Do not log health
checks but do keep request ids" is not expressible.** Either split the option, or
say plainly what `ignore` costs.

## An inbound `x-request-id` is trusted verbatim

**Low, but it is a trust boundary.** `curl -H 'x-request-id: MY-OWN-ID'` is echoed
and used as the correlation id. `nestjs-template` validated with `isUuid()` before
trusting it. As it stands a caller can forge or deliberately collide a trace id.

## `defaultErrorMapper` bypasses the bound Logger

**Bug. Low but ugly in production.** It writes the stack with `console.error`, so a
500 in a JSON-only service produces one structured `error` line **plus** a
multi-line, non-JSON, Bun-formatted dump that a log collector reads as several
broken records. A custom `onError` suppresses it; `defaultErrorMapper` offers no
option to. It should log through the injected `Logger` like everything else.
