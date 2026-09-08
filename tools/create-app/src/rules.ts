/**
 * The rules a dunx app breaks by omission rather than by mistake: each one is a
 * boot error, not a preference, and nothing in an editor points at it.
 *
 * One declaration, because two tools state them to the same audience.
 * `agents.ts` renders them into the `AGENTS.md` a scaffolded app carries, and
 * `scripts/gen-mcp-corpus.ts` bundles them into `@dunx/mcp`'s `dunx_start`, which
 * answers before there is an app at all. They were written twice and had already
 * drifted to six rules against four.
 */
export interface BootRule {
  /** One line, stated as the rule rather than as the mistake. */
  readonly rule: string;
  readonly detail: string;
}

export const BOOT_RULES: readonly BootRule[] = Object.freeze([
  {
    rule: 'Constructor injection needs the preload.',
    detail:
      'Add `preload = ["@dunx/transform/preload"]` to bunfig.toml, and again under `[test]`. It records each class\'s constructor parameter types at load time. Without it a class with constructor parameters is a boot error naming the preload.',
  },
  {
    rule: 'No `@Injectable()`, and no `@Inject()`.',
    detail:
      "Listing a class in a module's `providers` is what makes it injectable. dunx uses TC39 standard decorators, which have no parameter decorators. For a value with no constructor parameter to hang off, use `inject(Token)` in a field initializer.",
  },
  {
    rule: 'Do not add `reflect-metadata`, `experimentalDecorators` or `emitDecoratorMetadata`.',
    detail:
      '`@dunx/transform` records the constructor parameter types instead, and it needs none of them. Adding them does not make injection work; removing the preload line breaks it.',
  },
  {
    rule: 'A constructor parameter whose type is erased fails at boot, naming the parameter.',
    detail:
      'An interface, a primitive, a union, a class type parameter, or an `import type` at an injection site all record as `unresolved`. Inject a class, and drop `type` from the import.',
  },
  {
    rule: 'Relative imports carry a .js extension.',
    detail:
      '`import { UsersService } from \'./users.service.js\'`. The manifest is `"type": "module"` and resolution is nodenext, so an extensionless relative specifier does not resolve.',
  },
  {
    rule: "A module's `exports` is its public surface.",
    detail:
      'The container is scoped per module, so a provider another module injects has to be exported by the module that declares it. Absent `exports` means nothing is exported, and `global: true` publishes them app-wide.',
  },
  {
    rule: '`bun` only.',
    detail:
      'No `npm`, `npx`, `yarn` or `pnpm`. Run tools with `bunx` and scripts with `bun run <script>`.',
  },
]);
