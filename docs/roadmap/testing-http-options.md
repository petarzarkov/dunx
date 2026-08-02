# createTestServer silently omits HttpOptions

**Missing feature or design gap. Medium - it cost the porting agent real time.**

`createTestServer` accepts `middleware` and `onError` through
`Omit<HttpOptions, 'port' | 'overrides'>`. A suite that forgets them gets a server
with **no guards and no error mapper** that still boots and still answers 200s.

The porting agent's first integration run was 12 pass / 10 fail with no indication
that the application under test was not the application.

Nest has the same class of problem, but there the globals are applied to an app
object the test holds, so the omission is visible in the setup code. Here the
default is silently a different app.

## Options

- Require the options rather than defaulting them, so forgetting is a type error.
- Warn when a graph contains guard metadata and no middleware was supplied.
- Document the pattern the template settled on: one exported `httpOptions(config)`
  consumed by `main.ts` and every suite, so there is one definition of the app.

The third is the cheapest and is worth doing regardless of the others.
