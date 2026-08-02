import { parseSync } from 'oxc-parser';
import {
  isClassDeclaration,
  isIdentifier,
  isMethodDefinition,
  isParameterProperty,
  isTypeReference,
  nameOf,
  walk,
  type ClassNode,
  type Node,
} from './ast.js';
import { applyEdits, type Edit } from './edits.js';
import {
  collectTypeOnlyNames,
  erasedNames,
  type ErasureCause,
} from './erased.js';

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
  erased: ReadonlyMap<string, ErasureCause>,
): string => {
  const text = JSON.stringify(slice(source, param));
  const unresolved = `{ unresolved: ${text} }`;
  const annotation = annotationOf(param);

  if (!annotation || !isTypeReference(annotation)) return unresolved;

  const token = slice(source, annotation.typeName);
  // A qualified name (`ns.Thing`) is a runtime value; a bare erased name is not.
  const cause = erased.get(token);
  if (cause === undefined) return token;

  // The annotation reads the same whether the name was imported with
  // `import type` or declared as an interface, so the one case with a one-line
  // fix carries the identifier for the boot error to name.
  return cause === 'import-type'
    ? `{ unresolved: ${text}, typeOnly: ${JSON.stringify(token)} }`
    : unresolved;
};

/**
 * Records each class's constructor dependencies, and each decorated field's
 * declared type, as thunks on the class itself.
 *
 * A thunk, not a literal: the body is evaluated when the record is read rather
 * than when the module is defined, so a dependency declared later in the file -
 * or in a circular import - is not a temporal-dead-zone crash. That is what
 * removes the need for a `forwardRef` escape hatch, and it is also why a class decorator
 * cannot read the field record while it runs: the statement is appended after the
 * class, which is after decoration.
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
    throw new Error(`${filename}: could not parse - ${detail}`);
  }

  const program = parsed.program;
  const typeOnly = collectTypeOnlyNames(program);
  const edits: Edit[] = [];
  const annotated: string[] = [];

  walk(program, (node) => {
    if (!isClassDeclaration(node)) return;

    const name = node.id?.name;
    if (name === undefined) return;

    const erased = erasedNames(typeOnly, node);
    const params = constructorParams(node);

    if (params.length > 0) {
      const entries = params.map((param) => entryFor(source, param, erased));
      annotated.push(name);
      edits.push({
        start: node.end,
        end: node.end,
        text:
          `\nObject.defineProperty(${name}, ${DEPS_KEY}, {\n` +
          `  value: () => [${entries.join(', ')}],\n});`,
      });
    }
  });

  const code = applyEdits(source, edits);
  return { code, changed: code !== source, annotated };
};
