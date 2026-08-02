# overrides refuses a class the container would self-bind

**Bug (inconsistency). High - this is the unit-testing story.**

```ts
class Repo {}
class Svc {
  constructor(readonly repo: Repo) {}
}
@Module({ providers: [Svc] }) // Repo deliberately not listed
class M {}

await AppFactory.create(M); // works: Repo self-binds
await AppFactory.create(M, { overrides: [provide(Repo, { useValue: fake })] });
```

```
AppError: Nothing to override for Repo: no module in the graph binds it.
```

Guide 03 says "every class self-binds". `overrides` disagrees about the same class
in the same graph. **The most common thing to stub in a unit test is exactly a
collaborator nobody listed.**

The unmatched-override error exists for a good reason - a typo'd token silently
overriding nothing is worse - so the fix is not to drop the check. It is to treat a
resolvable-by-self-binding class as bound, or to accept an override for any class
token while still rejecting an unknown `token()`.

Workaround: list every overridable collaborator in the fixture module's providers.
