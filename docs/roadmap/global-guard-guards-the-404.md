# A global guard also guards the 404

**Design gap. Medium.** Found by porting `dunx-template`.

`listen()` installs one `fetch` fallback that puts the global middleware in front
of a `{"error":"NOT_FOUND","status":404}`. That is deliberate and documented: it
is how an unmatched path still gets a request-id and a log line.

But a global `SessionGuard` is global middleware. So with one installed, an
anonymous request for a path that does not exist answers **401, not 404** - and a
miss carries no route metadata, so there is no `@Public()` on it to read and no
way to make it public.

Defensible: not leaking which paths exist is a real posture, and some APIs choose
it. The gap is that **it is not a choice.** There is currently no way to keep the
logging and the request-id on a miss without also authenticating it.

## Options

1. Run only the middleware that opted in on the not-found path. Needs a marker,
   and "which middleware is safe on a miss" is a question every app answers
   differently.
2. Give the fallback a synthetic route metadata that reads as `@Public()`, so a
   guard sees a public route and passes. Smallest change, and makes 404 the
   default while leaving a guard free to check the flag if it wants 401.
3. `HttpFactory.create(root, { notFound: 'guarded' | 'public' })`. Explicit, one
   line, no marker vocabulary.

(2) matches what most apps expect from a 404 and does not add API. Whichever is
chosen, the current behaviour needs documenting either way - it is surprising and
currently undocumented.

Pinned in the template's `src/users/users.spec.ts`.
