/**
 * Minimal structural views over oxc's ESTree output — only the node shapes the
 * dependency transform reads. Verified against real `oxc-parser` output.
 */
export interface Node {
  readonly type: string;
  readonly start: number;
  readonly end: number;
}

export interface Identifier extends Node {
  readonly type: 'Identifier';
  readonly name: string;
  readonly typeAnnotation?: TSTypeAnnotation | null;
}

export interface ClassBody extends Node {
  readonly type: 'ClassBody';
  readonly body: readonly Node[];
}

/** `ClassDeclaration` and `ClassExpression` share every field read here. */
export interface ClassNode extends Node {
  readonly id: Identifier | null;
  readonly typeParameters: Node | null;
  readonly body: ClassBody;
}

export interface FunctionExpression extends Node {
  readonly params: readonly Node[];
}

export interface MethodDefinition extends Node {
  readonly type: 'MethodDefinition';
  readonly key: Node;
  readonly value: FunctionExpression;
}

export interface TSParameterProperty extends Node {
  readonly type: 'TSParameterProperty';
  readonly parameter: Node;
}

export interface TSTypeAnnotation extends Node {
  readonly type: 'TSTypeAnnotation';
  readonly typeAnnotation: Node;
}

export interface TSTypeReference extends Node {
  readonly type: 'TSTypeReference';
  readonly typeName: Node;
}

export interface ImportDeclaration extends Node {
  readonly type: 'ImportDeclaration';
  readonly specifiers: readonly Node[];
  readonly importKind: 'value' | 'type';
}

export interface ImportSpecifier extends Node {
  readonly type: 'ImportSpecifier';
  readonly local: Identifier;
  readonly importKind: 'value' | 'type';
}

const guard =
  <T extends Node>(type: T['type']) =>
  (node: Node | null | undefined): node is T =>
    node?.type === type;

export const isIdentifier = guard<Identifier>('Identifier');
export const isMethodDefinition = guard<MethodDefinition>('MethodDefinition');
export const isTypeReference = guard<TSTypeReference>('TSTypeReference');
export const isImportDeclaration =
  guard<ImportDeclaration>('ImportDeclaration');
export const isImportSpecifier = guard<ImportSpecifier>('ImportSpecifier');
export const isParameterProperty = guard<TSParameterProperty>(
  'TSParameterProperty',
);

/**
 * Declarations only. A `ClassExpression`'s own name is bound inside the class
 * body, not outside it, so a statement appended after `const X = class Foo {}`
 * could not reference `Foo` — it would be a ReferenceError at load.
 */
export const isClassDeclaration = (node: Node): node is ClassNode =>
  node.type === 'ClassDeclaration';

/**
 * Depth-first over every object in the tree. oxc's ESTree output is a plain
 * object graph with no parent links, so recursing every own value is safe and
 * needs no visitor-key table.
 */
export const walk = (root: unknown, visit: (node: Node) => void): void => {
  if (Array.isArray(root)) {
    for (const child of root) walk(child, visit);
    return;
  }
  if (root === null || typeof root !== 'object') return;

  const candidate = root as Partial<Node>;
  if (
    typeof candidate.type === 'string' &&
    typeof candidate.start === 'number' &&
    typeof candidate.end === 'number'
  ) {
    visit(root as Node);
  }

  for (const child of Object.values(root)) walk(child, visit);
};

export const nameOf = (node: Node | null | undefined): string | undefined =>
  isIdentifier(node) ? node.name : undefined;
