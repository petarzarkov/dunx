# JobPublisher.publish writes bare errors to stderr

**Bug. Medium.** Found by porting `dunx-template`.

With an unreachable broker, `JobPublisher.publish` both rejects (correct) **and**
writes two unstructured multi-line blocks to stderr, bypassing the bound `Logger`
entirely. In an app whose logging is JSON, that is unparseable noise interleaved
with the real log.

Not an unhandled rejection: a `process.on('unhandledRejection')` handler never
fires, so it is something inside writing directly.

12-line repro:

```ts
QueueModule.forRoot({
  url: 'redis://127.0.0.1:1',
  connection: { connectionTimeout: 300, maxRetries: 0 },
});
await app.get(JobPublisher).publish('q', 'j', {});
```

Twice:

```
RedisError: Connection closed
 code: "ERR_REDIS_CONNECTION_CLOSED"
```

Same class as the known `defaultErrorMapper` `console.error` finding: something on
a failure path reaches for the console instead of the injected `Logger`. Worth
fixing both together and adding a test that asserts nothing in `@dunx/infra`
writes to the console on a connection failure.
