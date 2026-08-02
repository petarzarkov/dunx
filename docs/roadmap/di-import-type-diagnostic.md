# import type on a constructor parameter breaks DI and the error points elsewhere

**Documentation gap plus misleading diagnostic. High frequency, low once known.**

```ts
import type { SyncDatabase } from '@dunx/infra/db'; // boot error
import { SyncDatabase } from '@dunx/infra/db'; // works
```

```
AppError: PaginationFactory cannot be constructed: parameter 1 (private readonly
db: SyncDatabase<typeof schema>) names nothing that exists at runtime.
```

The message quotes the annotation, which is **identical and correct in both
cases**, so it points at the wrong line. The porting agent hit it on four files
after "fixing" its imports.

Two things make this likely rather than rare:

- Guide 13 shows the annotation with no warning about the import.
- `@dunx/create-app`'s own tsconfig ships `verbatimModuleSyntax: true`, which is
  what makes editors and linters suggest `import type` in the first place.

A `type Db = SyncDatabase<...>` alias fails identically.

## Fix

The transform knows whether the identifier came from a type-only import: `erased.ts`
already tracks import kinds. The error should say so - "if `SyncDatabase` is
imported with `import type`, make it a value import" - which turns a hunt into a
one-line fix. Guide 13 should show the import line.
