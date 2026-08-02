# A mounted handler is documented as a literal `*` path

**Bug. Medium.** Found by porting `dunx-template` onto the real packages.

Route discovery sees `@dunx/auth`'s mounted handler as an ordinary controller and
emits:

```
/api/auth/*   ->  5 operations, tagged "MountedAuthHandler"
```

Three things wrong with that one line:

- `*` is not an OpenAPI path template, so the entry is not valid against the spec.
- `MountedAuthHandler` is an internal class name leaking into a public document.
- It duplicates the 45 paths `betterAuthDocument` describes properly, which now
  land correctly since contributed paths stopped being re-prefixed.

## What is missing

**There is no way to exclude a controller from the document.** `@ApiDoc` can
annotate one, and `Public()` changes security, but nothing says "route discovery
should skip this". A wildcard mount is the case that needs it: the handler is
real, it must be routed, and it is describable only by the library behind it.

Options, roughly in order of preference:

1. An `@ApiHidden()` marker `describeRoutes` honours. Reads well next to the
   handler and is useful beyond auth, e.g. internal health probes.
2. Skip wildcard paths automatically. Narrower, needs no new API, and is
   defensible because `*` cannot be expressed in the spec anyway - but it is
   silent, and silence is what produced this.

Pinned as a KNOWN GAP in the template's `src/openapi.spec.ts`, so it fails when
it is fixed.
