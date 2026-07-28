/**
 * Local oxlint JS plugin. oxlint has no `no-restricted-syntax` and no built-in
 * enum rule, so the repo's enum ban is enforced here.
 *
 * Types are hand-written: `oxlint/plugins-dev` is alpha and currently exports only
 * a placeholder, so importing from it would buy nothing.
 */
interface AstNode {
  readonly type: string;
  readonly name?: string;
}

interface RuleContext {
  report(descriptor: { node: AstNode; message: string }): void;
}

interface RuleModule {
  readonly create: (
    context: RuleContext,
  ) => Record<string, (node: AstNode) => void>;
}

const NO_ENUM_MESSAGE =
  'enum is banned in this repo. An enum is the one TypeScript construct that ' +
  'cannot be erased — it emits a runtime object with reverse mappings. Use a frozen ' +
  'object plus an indexed-access union instead:\n' +
  '  export const Status = Object.freeze({ OK: 200 } as const);\n' +
  '  export type Status = (typeof Status)[keyof typeof Status];';

// Covers `enum`, `const enum` and `declare enum` — all parse to TSEnumDeclaration.
const noEnum: RuleModule = {
  create: (context) => ({
    TSEnumDeclaration: (node) => {
      context.report({ node, message: NO_ENUM_MESSAGE });
    },
  }),
};

const NO_BRAND_PREFIX_MESSAGE =
  'Do not prefix identifiers with "Dunx". The framework brand belongs in the ' +
  'package name, not in every symbol a user reads. Use the "App" prefix instead ' +
  '— AppFactory, AppError, Application.';

const noBrandPrefix: RuleModule = {
  create: (context) => ({
    Identifier: (node) => {
      if (node.name?.startsWith('Dunx') !== true) return;
      context.report({ node, message: NO_BRAND_PREFIX_MESSAGE });
    },
  }),
};

export default {
  meta: { name: 'dunx' },
  rules: { 'no-brand-prefix': noBrandPrefix, 'no-enum': noEnum },
};
