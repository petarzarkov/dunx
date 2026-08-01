/**
 * Structural views over oxc's ESTree-with-TypeScript output — only the node
 * shapes the doc extractor reads. Same technique, and the same reasoning, as
 * `packages/compiler/src/ast.ts`: oxc hands back a plain object graph, so a
 * narrow interface per node kind beats importing a full AST type package.
 */
export interface Node {
  readonly type: string;
  readonly start: number;
  readonly end: number;
}

export interface Identifier extends Node {
  readonly type: 'Identifier';
  readonly name: string;
}

export interface Literal extends Node {
  readonly type: 'Literal';
  readonly value: unknown;
}

export interface Program extends Node {
  readonly body: readonly Node[];
}

export interface ClassBody extends Node {
  readonly body: readonly ClassMember[];
}

export interface ClassMember extends Node {
  readonly key?: Node | null;
  readonly value?: (Node & { readonly body?: Node | null }) | null;
  readonly typeAnnotation?: Node | null;
  readonly static?: boolean;
  readonly readonly?: boolean;
  readonly optional?: boolean;
  readonly computed?: boolean;
  readonly kind?: string;
  readonly accessibility?: string | null;
}

export interface ClassDeclaration extends Node {
  readonly type: 'ClassDeclaration';
  readonly id: Identifier | null;
  readonly body: ClassBody;
  readonly abstract?: boolean;
}

export interface FunctionDeclaration extends Node {
  readonly type: 'FunctionDeclaration';
  readonly id: Identifier | null;
  readonly body: Node | null;
}

export interface InterfaceBody extends Node {
  readonly body: readonly ClassMember[];
}

export interface InterfaceDeclaration extends Node {
  readonly type: 'TSInterfaceDeclaration';
  readonly id: Identifier;
  readonly body: InterfaceBody;
}

export interface TypeAliasDeclaration extends Node {
  readonly type: 'TSTypeAliasDeclaration';
  readonly id: Identifier;
}

export interface VariableDeclarator extends Node {
  readonly id: Node;
  readonly init: Node | null;
  readonly typeAnnotation?: Node | null;
}

export interface VariableDeclaration extends Node {
  readonly type: 'VariableDeclaration';
  readonly kind: string;
  readonly declarations: readonly VariableDeclarator[];
}

export interface ExportSpecifier extends Node {
  readonly local: Node;
  readonly exported: Node;
}

export interface ExportNamedDeclaration extends Node {
  readonly type: 'ExportNamedDeclaration';
  readonly declaration: Node | null;
  readonly specifiers: readonly ExportSpecifier[];
  readonly source: Literal | null;
  readonly exportKind: 'value' | 'type';
}

export interface ExportAllDeclaration extends Node {
  readonly type: 'ExportAllDeclaration';
  readonly source: Literal;
  readonly exported: Node | null;
  readonly exportKind: 'value' | 'type';
}

export interface Comment {
  readonly type: 'Line' | 'Block';
  readonly value: string;
  readonly start: number;
  readonly end: number;
}

const guard =
  <T extends Node>(type: string) =>
  (node: Node | null | undefined): node is T =>
    node?.type === type;

export const isIdentifier = guard<Identifier>('Identifier');
export const isClassDeclaration = guard<ClassDeclaration>('ClassDeclaration');
export const isFunctionDeclaration = guard<FunctionDeclaration>(
  'FunctionDeclaration',
);
export const isInterfaceDeclaration = guard<InterfaceDeclaration>(
  'TSInterfaceDeclaration',
);
export const isTypeAlias = guard<TypeAliasDeclaration>(
  'TSTypeAliasDeclaration',
);
export const isVariableDeclaration = guard<VariableDeclaration>(
  'VariableDeclaration',
);
export const isExportNamed = guard<ExportNamedDeclaration>(
  'ExportNamedDeclaration',
);
export const isExportAll = guard<ExportAllDeclaration>('ExportAllDeclaration');

/**
 * The exported name of a specifier. `export { a as "b" }` is legal, so the
 * node is either an Identifier or a string Literal.
 */
export const nameOf = (node: Node | null | undefined): string | undefined => {
  if (isIdentifier(node)) return node.name;
  if (node?.type === 'Literal') {
    const value = (node as Literal).value;
    return typeof value === 'string' ? value : undefined;
  }
  return undefined;
};

/** 1-based line number for a source offset. */
export const lineIndex = (source: string): ((offset: number) => number) => {
  const starts: number[] = [0];
  for (let i = 0; i < source.length; i++) {
    if (source[i] === '\n') starts.push(i + 1);
  }
  return (offset) => {
    let low = 0;
    let high = starts.length - 1;
    while (low < high) {
      const mid = (low + high + 1) >> 1;
      if ((starts[mid] ?? 0) <= offset) low = mid;
      else high = mid - 1;
    }
    return low + 1;
  };
};
