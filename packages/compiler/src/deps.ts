import { parseSync } from 'oxc-parser';
import {
  isClassDeclaration,
  isIdentifier,
  isImportDeclaration,
  isImportSpecifier,
  isMethodDefinition,
  isParameterProperty,
  isTypeReference,
  nameOf,
  walk,
  type ClassNode,
  type Node,
} from './ast.js';
import { applyEdits, type Edit } from './edits.js';

/**
 * `Symbol.for`, not `Symbol`: two copies of `@dunx/core` in one dependency tree
 * still agree on the key. Same technique as module and route markers.
 */
const DEPS_KEY = "Symbol.for('dunx.deps')";

export interface TransformResult {
  readonly code: string;
  readonly changed: boolean;
  /** Classes that received dependency metadata, in source order. */
  readonly annotated: readonly string[];
}

const slice = (source: string, node: Node): string =>
  source.slice(node.start, node.end);

/**
 * Names that exist only in the type system, so emitting them in a value position
 * would be a `ReferenceError` at runtime. Collected per file: type-only imports,
 * inline `type` specifiers, local interfaces and type aliases.
 */
const collectTypeOnlyNames = (program: Node): ReadonlySet<string> => {
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

const constructorParams = (klass: ClassNode): readonly Node[] => {
  const found = klass.body.body.find(
    (member) =>
      isMethodDefinition(member) && nameOf(member.key) === 'constructor',
  );
  return isMethodDefinition(found) ? found.value.params : [];
};

/** The declared type of a parameter, unwrapping `private readonly x: X`. */
const annotationOf = (param: Node): Node | undefined => {
  const inner = isParameterProperty(param) ? param.parameter : param;
  if (!isIdentifier(inner)) return undefined;
  return inner.typeAnnotation?.typeAnnotation;
};

/**
 * One entry per constructor parameter. A parameter whose type names something
 * that exists at runtime becomes that expression; anything else becomes an
 * `unresolved` descriptor so the container can name it precisely at boot instead
 * of constructing a broken object.
 */
const entryFor = (
  source: string,
  param: Node,
  erased: ReadonlySet<string>,
): string => {
  const unresolved = `{ unresolved: ${JSON.stringify(slice(source, param))} }`;
  const annotation = annotationOf(param);

  if (!annotation || !isTypeReference(annotation)) return unresolved;

  const token = slice(source, annotation.typeName);
  // A qualified name (`ns.Thing`) is a runtime value; a bare erased name is not.
  if (erased.has(token)) return unresolved;

  return token;
};

/**
 * Records each class's constructor dependencies as a thunk on the class itself.
 *
 * A thunk, not an array: the body is evaluated when the container resolves the
 * class rather than when the module is defined, so a dependency declared later in
 * the file — or in a circular import — is not a temporal-dead-zone crash. That is
 * what removes the need for Nest's `forwardRef`.
 */
export const transform = (
  source: string,
  filename = 'input.ts',
): TransformResult => {
  const parsed = parseSync(filename, source);

  if (parsed.errors.length > 0) {
    const detail = parsed.errors
      .slice(0, 3)
      .map((error) => error.message)
      .join('; ');
    throw new Error(`${filename}: could not parse — ${detail}`);
  }

  const program = parsed.program;
  const typeOnly = collectTypeOnlyNames(program);
  const edits: Edit[] = [];
  const annotated: string[] = [];

  walk(program, (node) => {
    if (!isClassDeclaration(node)) return;

    const name = node.id?.name;
    if (name === undefined) return;

    const params = constructorParams(node);
    if (params.length === 0) return;

    const erased = new Set([...typeOnly, ...collectTypeParameters(node)]);
    const entries = params.map((param) => entryFor(source, param, erased));

    annotated.push(name);
    edits.push({
      start: node.end,
      end: node.end,
      text:
        `\nObject.defineProperty(${name}, ${DEPS_KEY}, {\n` +
        `  value: () => [${entries.join(', ')}],\n});`,
    });
  });

  const code = applyEdits(source, edits);
  return { code, changed: code !== source, annotated };
};
