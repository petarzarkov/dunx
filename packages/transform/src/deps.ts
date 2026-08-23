import { parseSync } from 'oxc-parser';
import {
  isAssignmentPattern,
  isClassDeclaration,
  isIdentifier,
  isMethodDefinition,
  isParameterProperty,
  isTypeReference,
  nameOf,
  rootOfTypeName,
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

/**
 * The binding a parameter declares, unwrapping `private readonly x: X` and
 * `x: X = fallback` down to the identifier that carries the annotation.
 */
const bindingOf = (param: Node): Node => {
  const named = isParameterProperty(param) ? param.parameter : param;
  return isAssignmentPattern(named) ? named.left : named;
};

/** The declared type of a parameter, or undefined when it has none. */
const annotationOf = (param: Node): Node | undefined => {
  const inner = bindingOf(param);
  if (!isIdentifier(inner)) return undefined;
  return inner.typeAnnotation?.typeAnnotation;
};

/**
 * A default makes the parameter optional in the language, so an erased type is
 * no longer a boot error: the container passes `undefined` and the default
 * stands. A resolvable type is still injected, and the default only applies to
 * a `new` the container did not make.
 */
const hasDefault = (param: Node): boolean =>
  isAssignmentPattern(isParameterProperty(param) ? param.parameter : param);

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
  const optional = hasDefault(param) ? ', optional: true' : '';
  const unresolved = `{ unresolved: ${text}${optional} }`;
  const annotation = annotationOf(param);

  if (!annotation || !isTypeReference(annotation)) return unresolved;

  const root = nameOf(rootOfTypeName(annotation.typeName));
  const cause = root === undefined ? undefined : erased.get(root);
  // `ns.Thing` is a member access on a value the file imported, so it resolves
  // as written; only its leftmost name has to survive erasure.
  if (cause === undefined) return slice(source, annotation.typeName);

  // The annotation reads the same whether the name was imported with
  // `import type` or declared as an interface, so the one case with a one-line
  // fix carries the identifier for the boot error to name.
  return cause === 'import-type'
    ? `{ unresolved: ${text}${optional}, typeOnly: ${JSON.stringify(root)} }`
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
        // One line, appended to the class's own closing brace. A record spread
        // over three lines shifted everything below it, so a throw in the third
        // class of a file reported a line six further down than the source's.
        text:
          `;Object.defineProperty(${name}, ${DEPS_KEY}, ` +
          `{ value: () => [${entries.join(', ')}] });`,
      });
    }
  });

  const code = applyEdits(source, edits);
  return { code, changed: code !== source, annotated };
};
