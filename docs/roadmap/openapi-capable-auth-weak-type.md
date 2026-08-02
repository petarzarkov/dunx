# The documented "no openAPI() plugin" path does not compile

**Bug. Medium.** Found by porting `dunx-template`.

`OpenApiCapableAuth` is a weak type:

```ts
export interface OpenApiCapableAuth {
  readonly api: { generateOpenAPISchema?: () => Promise<unknown> };
}
```

Every property optional means TypeScript applies the weak-type check, and a Better
Auth instance whose `api` shares no property with it is rejected outright:

```
error TS2345: 'InferAPI<...>' has no properties in common with type
'{ generateOpenAPISchema?: (() => Promise<unknown>) | undefined; }'
```

`betterAuthDocument`'s own doc comment says a missing plugin "contributes nothing
rather than throwing". At runtime that is true and tested. In TypeScript it is a
compile error, so the documented path cannot be written.

The practical trigger is worse than the plugin being absent. Annotating an options
builder `: BetterAuthOptions` widens `plugins` to the base type, so `betterAuth()`
returns an instance without `generateOpenAPISchema` in its inferred API and the
call stops compiling. **`satisfies BetterAuthOptions` is effectively mandatory and
nothing says so.**

## Fix

Give the interface one required member so the weak-type check does not apply, or
accept `unknown` and narrow inside. Then document `satisfies` on the options
builder, because that is the shape every consumer will write first.
