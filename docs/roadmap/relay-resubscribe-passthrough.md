# HttpOptions cannot pass RelayOptions.resubscribe

**Missing feature. Low.** Found by porting `dunx-template`.

`HttpOptions` exposes `relay` and `relayChannel`, and 0.2.5 supplies `onError`
internally routed to the bound `Logger`, which is right. But `RelayOptions.resubscribe`

- the doubling backoff added for a relay whose Redis connection drops - is not
  reachable from there.

The only way to set it is `app.get(PubSub).relayThrough(...)`, which then
conflicts with the declarative path:

```
AppError: PubSub already relays
```

So an app that wants a resubscribe policy has to give up `HttpOptions.relay`
entirely and wire the relay by hand, which is a strange trade for one option.

## Fix

Thread `resubscribe` through `HttpOptions` next to `relayChannel`. It is a
pass-through with no design question attached.
