import {
  isImportDeclaration,
  isImportSpecifier,
  nameOf,
  walk,
  type ClassNode,
  type Node,
} from './ast.js';

/**
 * Names that exist only in the type system, so emitting them in a value position
 * would be a `ReferenceError` at runtime. Collected per file: type-only imports,
 * inline `type` specifiers, local interfaces and type aliases.
 */
export const collectTypeOnlyNames = (program: Node): ReadonlySet<string> => {
  const names = new Set<string>();

  walk(program, (node) => {
    if (isImportDeclaration(node)) {
      for (const specifier of node.specifiers) {
        if (!isImportSpecifier(specifier)) continue;
        if (node.importKind === 'type' || specifier.importKind === 'type') {
          names.add(specifier.local.name);
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
      if (name !== undefined) names.add(name);
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
  typeOnly: ReadonlySet<string>,
  klass: ClassNode,
): ReadonlySet<string> =>
  new Set([...typeOnly, ...collectTypeParameters(klass)]);
