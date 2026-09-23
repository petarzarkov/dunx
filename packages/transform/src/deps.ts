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
  boundNames,
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

const constructorOf = (klass: ClassNode) =>
  klass.body.body.find(
    (member) =>
      isMethodDefinition(member) && nameOf(member.key) === 'constructor',
  );

const declaresConstructor = (klass: ClassNode): boolean =>
  constructorOf(klass) !== undefined;

const constructorParams = (klass: ClassNode): readonly Node[] => {
  const found = constructorOf(klass);
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
  bound: ReadonlySet<string>,
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
  if (cause === undefined) {
    const named = slice(source, annotation.typeName);
    if (root === undefined || bound.has(root)) return named;

    /**
     * An ambient name. With no type checker `ErrorOptions` and `URL` read the
     * same - a lib interface that erases, a lib class that is a usable token -
     * and emitting either verbatim made the first a `ReferenceError`.
     *
     * `typeof` settles it at resolution time, on the **leftmost** name because
     * it only protects a bare identifier. A qualified name needs the second
     * half too: an absent member is `undefined`, which `isUnresolved` rejects,
     * so the container would take it as a token rather than raise.
     */
    const missing =
      named === root
        ? `typeof ${root} === 'undefined'`
        : `typeof ${root} === 'undefined' || ${named} === undefined`;

    return `${missing} ? ${unresolved} : ${named}`;
  }

  // The annotation reads the same whether the name was imported with
  // `import type` or declared as an interface, so the one case with a one-line
  // fix carries the identifier for the boot error to name.
  return cause === 'import-type'
    ? `{ unresolved: ${text}${optional}, typeOnly: ${JSON.stringify(root)} }`
    : unresolved;
};

/**
 * Records each class's constructor dependencies as a thunk on the class itself.
 *
 * A thunk, not a literal: the body is evaluated when the record is read rather
 * than when the module is defined, so a dependency declared later in the file -
 * or in a circular import - is not a temporal-dead-zone crash. That is what
 * removes the need for a `forwardRef` escape hatch, and it is also why a class decorator
 * cannot read the record while it runs: the statement is appended after the
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
  const bound = boundNames(program);
  const edits: Edit[] = [];
  const annotated: string[] = [];

  walk(program, (node) => {
    if (!isClassDeclaration(node)) return;

    const name = node.id?.name;
    if (name === undefined) return;

    const erased = erasedNames(typeOnly, node);
    const params = constructorParams(node);

    // A subclass whose own constructor takes nothing still needs a record, or
    // it inherits its base's and is handed arguments it never declared.
    if (
      params.length > 0 ||
      (node.superClass !== null && declaresConstructor(node))
    ) {
      const entries = params.map((param) =>
        entryFor(source, param, erased, bound),
      );
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
