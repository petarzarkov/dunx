# A DynamicModule naming a decorated class unions both option sets

**Bug. High.** Found porting `nestjs-template`.

The canonical Nest pattern - a production `@Module` decorator plus a static
returning a test-configured `DynamicModule` - does not work, and the error is a
dead end.

```ts
@Module({ providers: [provide(A, { useValue: 'decorator-A' })] })
class Root {
  static dyn(): DynamicModule {
    return { module: Root, providers: [provide(B, { useValue: 'dynamic-B' })] };
  }
}
await AppFactory.create(Root.dyn());
// A resolves to 'decorator-A': the dynamic options did not override, they unioned.
```

With a real module list, every `X.forRoot()` in the decorator registers twice:

```
AppError: Duplicate binding for ConfigInput: bound by module "ConfigModule" and
module "ConfigModule". The container is flat - one binding per token.
```

**The message names the same module twice** and never hints that the root itself
was collected twice, which is the actual cause.

Guide 04 documents "dedup is per reference, not per module identity" but not this
case.

## To decide

Either the `DynamicModule`'s options replace the decorator's, or they union and
that is documented. Whichever it is, the duplicate-binding error must be able to
say "the same module was collected twice" instead of printing one name twice.

Workaround in the template: an undecorated class plus one `appModule(options)`
factory.
