// @ts-check
/**
 * Local oxlint JS plugin. oxlint has no `no-restricted-syntax` and no built-in
 * enum rule, so the repo's enum ban is enforced here.
 *
 * **JavaScript, not TypeScript, and that is deliberate.** oxlint loads a JS
 * plugin by spawning **Node**, not Bun — so a `.ts` file here fails with
 * `ERR_UNKNOWN_FILE_EXTENSION` on any Node without type stripping (below 22.18).
 * That broke the pre-commit hook for anyone whose default `node` was older, and
 * made CI depend on which Node the runner image happened to ship. A `.js` file
 * loads on every Node there is.
 *
 * The types it had were three hand-written interfaces with no imports —
 * `oxlint/plugins-dev` is alpha and exports only a placeholder — so they cost
 * nothing to express as JSDoc, and `@ts-check` still checks them.
 *
 * @typedef {{ readonly type: string, readonly name?: string }} AstNode
 * @typedef {{ report(descriptor: { node: AstNode, message: string }): void }} RuleContext
 * @typedef {{ readonly create: (context: RuleContext) => Record<string, (node: AstNode) => void> }} RuleModule
 */

const NO_ENUM_MESSAGE =
  'enum is banned in this repo. An enum is the one TypeScript construct that ' +
  'cannot be erased — it emits a runtime object with reverse mappings. Use a frozen ' +
  'object plus an indexed-access union instead:\n' +
  '  export const Status = Object.freeze({ OK: 200 } as const);\n' +
  '  export type Status = (typeof Status)[keyof typeof Status];';

/**
 * Covers `enum`, `const enum` and `declare enum` — all parse to TSEnumDeclaration.
 * @type {RuleModule}
 */
const noEnum = {
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

/** @type {RuleModule} */
const noBrandPrefix = {
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
