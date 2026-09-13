import {
  isClassDeclaration,
  isImportDeclaration,
  nameOf,
  walk,
  type ClassNode,
  type ImportSpecifier,
  type Node,
} from './ast.js';

/**
 * Why a name cannot be used in a value position. Kept apart because only one of
 * these has a one-line fix: an `import type` becomes a value import, whereas an
 * interface has no runtime counterpart to import at all. The boot error quotes
 * the annotation, which reads identically either way, so without this the
 * message points at a line that is already correct.
 */
export type ErasureCause = 'import-type' | 'declared-type';

/**
 * A class puts its name in both the type and the value space, so an interface
 * merging into it still describes something that exists at runtime. Every other
 * pairing - `const X` beside `interface X`, `function X` beside `interface X` -
 * leaves the annotation pointing at the type alone, which is erased.
 *
 * Top level only. A class nested in a function does not shadow a file-level
 * interface at the point a constructor is annotated.
 */
const mergedClassNames = (program: Node): ReadonlySet<string> => {
  const body = (program as { body?: readonly Node[] }).body ?? [];
  const names = new Set<string>();

  for (const statement of body) {
    const declaration =
      (statement as { declaration?: Node | null }).declaration ?? statement;
    if (!isClassDeclaration(declaration)) continue;
    const name = declaration.id?.name;
    if (name !== undefined) names.add(name);
  }

  return names;
};

/**
 * Names that exist only in the type system, so emitting them in a value position
 * would be a `ReferenceError` at runtime. Collected per file: type-only imports,
 * inline `type` specifiers, local interfaces and type aliases.
 */
export const collectTypeOnlyNames = (
  program: Node,
): ReadonlyMap<string, ErasureCause> => {
  const names = new Map<string, ErasureCause>();

  walk(program, (node) => {
    if (isImportDeclaration(node)) {
      for (const specifier of node.specifiers) {
        const { local, importKind } = specifier as ImportSpecifier;
        if (node.importKind !== 'type' && importKind !== 'type') continue;
        const name = nameOf(local);
        if (name !== undefined) names.set(name, 'import-type');
      }
      return;
    }

    if (
      node.type === 'TSInterfaceDeclaration' ||
      node.type === 'TSTypeAliasDeclaration'
    ) {
      const declared = (node as { id?: Node }).id;
      const name = nameOf(declared);
      if (name !== undefined) names.set(name, 'declared-type');
    }
  });

  for (const name of mergedClassNames(program)) names.delete(name);

  return names;
};

/**
 * Every name this file binds **at runtime**: imported, or declared at the top
 * level. Anything else a constructor annotation names is ambient.
 *
 * Two ways a name looks bound and is not, each of which would suppress
 * `entryFor`'s guard and bring the `ReferenceError` back: a `declare`, which
 * promises a runtime value this file does not create, and a binding nested in a
 * function, which is not in scope at a constructor signature. Top-level
 * statements only, for the second - a `walk` would collect it.
 */
export const boundNames = (program: Node): ReadonlySet<string> => {
  const names = new Set<string>();

  const bind = (node: Node | undefined | null): void => {
    const name = nameOf(node);
    if (name !== undefined) names.add(name);
  };

  for (const statement of (program as { body?: readonly Node[] }).body ?? []) {
    if (isImportDeclaration(statement)) {
      for (const specifier of statement.specifiers) {
        bind((specifier as ImportSpecifier).local);
      }
      continue;
    }

    const declaration =
      (statement as { declaration?: Node | null }).declaration ?? statement;
    if ((declaration as { declare?: boolean }).declare === true) continue;

    if (declaration.type === 'VariableDeclaration') {
      // An id that is a pattern binds nothing a token could name, and `nameOf`
      // answers `undefined` for one.
      for (const declarator of (
        declaration as { declarations?: readonly Node[] }
      ).declarations ?? []) {
        bind((declarator as { id?: Node }).id);
      }
      continue;
    }

    if (
      isClassDeclaration(declaration) ||
      declaration.type === 'FunctionDeclaration' ||
      declaration.type === 'TSEnumDeclaration' ||
      declaration.type === 'TSModuleDeclaration'
    ) {
      bind((declaration as { id?: Node }).id);
    }
  }

  return names;
};

/** A class's own type parameters are erased, so `T` is never a usable token. */
const collectTypeParameters = (klass: ClassNode): ReadonlySet<string> => {
  const names = new Set<string>();
  if (klass.typeParameters === null) return names;

  walk(klass.typeParameters, (node) => {
    if (node.type !== 'TSTypeParameter') return;
    const name = nameOf((node as { name?: Node }).name);
    if (name !== undefined) names.add(name);
  });

  return names;
};

/** Every name in this file that a value position cannot use. */
export const erasedNames = (
  typeOnly: ReadonlyMap<string, ErasureCause>,
  klass: ClassNode,
): ReadonlyMap<string, ErasureCause> =>
  new Map<string, ErasureCause>([
    ...typeOnly,
    // A type parameter is erased for the same reason an interface is: there is
    // nothing to import.
    ...[...collectTypeParameters(klass)].map(
      (name) => [name, 'declared-type'] as const,
    ),
  ]);
