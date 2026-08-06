import type {
  ClassDeclaration,
  ClassMember,
  FunctionDeclaration,
  InterfaceDeclaration,
  Node,
  VariableDeclaration,
  VariableDeclarator,
} from './ast';

/**
 * Longest initializer kept inline. Generous because the frozen-object-plus-union
 * pattern that stands in for `enum` here _is_ the documentation - truncating it
 * to the name would hide every member.
 */
const INLINE_LIMIT = 900;

const trimTail = (text: string): string => text.trim().replace(/[;,]$/, '');

/**
 * Removes the indentation the declaration sat at in its source file, so a
 * multi-line signature does not render with a ragged left edge.
 */
export const dedent = (text: string): string => {
  const [first, ...rest] = text.split('\n');
  if (rest.length === 0) return text.trim();

  const indents = rest
    .filter((line) => line.trim() !== '')
    .map((line) => line.length - line.trimStart().length);
  const shift = indents.length > 0 ? Math.min(...indents) : 0;

  return [
    (first ?? '').trim(),
    ...rest.map((line) => line.slice(shift).trimEnd()),
  ]
    .join('\n')
    .trim();
};

const upTo = (source: string, node: Node, boundary: Node | null): string =>
  dedent(source.slice(node.start, boundary ? boundary.start : node.end));

export const classSignature = (
  source: string,
  node: ClassDeclaration,
): string => trimTail(upTo(source, node, node.body));

export const functionSignature = (
  source: string,
  node: FunctionDeclaration,
): string => trimTail(upTo(source, node, node.body));

export const interfaceSignature = (
  source: string,
  node: InterfaceDeclaration,
): string => trimTail(upTo(source, node, node.body));

export const typeAliasSignature = (source: string, node: Node): string =>
  trimTail(dedent(source.slice(node.start, node.end)));

const FUNCTION_INITS = new Set([
  'ArrowFunctionExpression',
  'FunctionExpression',
]);

/** `export const f = (a: string): void => {}` is the dominant export style in
 * this repo, so a variable initialised with a function is rendered as one:
 * everything up to the arrow, and none of the body. */
export const isFunctionInitialised = (
  declarator: VariableDeclarator,
): boolean => FUNCTION_INITS.has(declarator.init?.type ?? '');

export const variableSignature = (
  source: string,
  declaration: VariableDeclaration,
  index: number,
): string => {
  const declarator = declaration.declarations[index];
  if (!declarator) return declaration.kind;

  const annotated = (declarator.id as { typeAnnotation?: Node | null })
    .typeAnnotation;
  if (annotated) {
    return trimTail(
      `${declaration.kind} ${dedent(source.slice(declarator.id.start, annotated.end))}`,
    );
  }

  const init = declarator.init;
  if (init && isFunctionInitialised(declarator)) {
    const body = (init as { body?: Node | null }).body;
    const head = dedent(
      source.slice(declarator.start, body ? body.start : init.end),
    );
    return `${declaration.kind} ${head.replace(/\s*$/, '')}`;
  }

  const whole = dedent(source.slice(declarator.start, declarator.end));
  if (whole.length <= INLINE_LIMIT)
    return trimTail(`${declaration.kind} ${whole}`);

  return `${declaration.kind} ${dedent(whole.slice(0, INLINE_LIMIT))} …`;
};

/**
 * Class and interface members. A method stops at its body; a property with a
 * declared type stops at the annotation, so a large frozen-object literal does
 * not become the signature.
 */
export const memberSignature = (
  source: string,
  member: ClassMember,
): string => {
  if (member.type === 'MethodDefinition' && member.value) {
    return trimTail(upTo(source, member, member.value.body ?? null));
  }

  if (member.typeAnnotation) {
    return trimTail(
      dedent(source.slice(member.start, member.typeAnnotation.end)),
    );
  }

  const whole = dedent(source.slice(member.start, member.end));
  if (whole.length <= INLINE_LIMIT) return trimTail(whole);
  return trimTail(whole.slice(0, INLINE_LIMIT)) + ' …';
};
