# drizzleDatabase's doc comment is wrong about the schema

**Documentation error. Medium.** Found by porting `dunx-template`.

The comment says "the better-auth tables being in the app's schema object is the
whole requirement". They are not enough. The adapter looks each model up by
**export name**:

```ts
fullSchema['user'];
```

So a barrel that exports the table as `users` fails on the first query:

```
BetterAuthError: [# Drizzle Adapter]: The model "user" was not found in the schema object.
```

The explicit mapping is required, and nothing currently says so:

```ts
schema: { user: users, session: sessions, account: accounts, verification: verifications }
```

Straight documentation fix in `packages/auth`, plus a line in the auth guide. The
failure is at first query rather than at boot, which is what makes it worth
calling out: it looks like a data problem, not a wiring one.
