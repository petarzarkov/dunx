import {
  isImportDeclaration,
  isImportSpecifier,
  nameOf,
  walk,
  type ClassNode,
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
        if (!isImportSpecifier(specifier)) continue;
        if (node.importKind === 'type' || specifier.importKind === 'type') {
          names.set(specifier.local.name, 'import-type');
        }
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

  return names;
};

/** A class's own type parameters are erased, so `T` is never a usable token. */
export const collectTypeParameters = (
  klass: ClassNode,
): ReadonlySet<string> => {
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
