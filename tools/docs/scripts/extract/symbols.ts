import {
  isClassDeclaration,
  isExportNamed,
  isFunctionDeclaration,
  isInterfaceDeclaration,
  isTypeAlias,
  isVariableDeclaration,
  lineIndex,
  nameOf,
  type ClassMember,
  type Comment,
  type Node,
  type Program,
} from './ast';
import { createDocFinder, parseJsdoc } from './jsdoc';
import {
  MemberKind,
  SymbolKind,
  type DocComment,
  type DocMember,
  type DocSymbol,
} from './model';
import {
  classSignature,
  functionSignature,
  interfaceSignature,
  isFunctionInitialised,
  memberSignature,
  typeAliasSignature,
  variableSignature,
} from './signature';

export interface FileSymbols {
  /** Locally declared and exported, keyed by the name it is exported under. */
  readonly symbols: readonly DocSymbol[];
}

interface Declared {
  readonly node: Node;
  readonly declaration: Node;
  /** Index into a VariableDeclaration's declarator list, otherwise -1. */
  readonly declaratorIndex: number;
}

const MEMBER_KINDS: Record<string, MemberKind> = {
  constructor: MemberKind.Constructor,
  get: MemberKind.Accessor,
  set: MemberKind.Accessor,
  method: MemberKind.Method,
};

const isHidden = (member: ClassMember): boolean =>
  member.accessibility === 'private' ||
  member.accessibility === 'protected' ||
  member.key?.type === 'PrivateIdentifier';

const memberKind = (member: ClassMember): MemberKind => {
  if (member.type === 'MethodDefinition') {
    return MEMBER_KINDS[member.kind ?? 'method'] ?? MemberKind.Method;
  }
  if (member.type === 'TSMethodSignature') return MemberKind.Method;
  if (member.type === 'AccessorProperty') return MemberKind.Accessor;
  return MemberKind.Property;
};

const memberName = (member: ClassMember): string | undefined => {
  if (member.type === 'TSIndexSignature') return '[index]';
  if (member.type === 'TSCallSignatureDeclaration') return '()';
  if (member.type === 'TSConstructSignatureDeclaration') return 'new ()';
  return nameOf(member.key);
};

/**
 * A list per name, not one entry: the frozen-object-plus-indexed-access-union
 * that stands in for `enum` here declares the value and the type under the same
 * name, and dropping either half would document half the construct.
 */
const collectDeclarations = (program: Program): Map<string, Declared[]> => {
  const declared = new Map<string, Declared[]>();

  const add = (name: string, entry: Declared): void => {
    const list = declared.get(name);
    if (list) list.push(entry);
    else declared.set(name, [entry]);
  };

  const record = (node: Node, declaration: Node): void => {
    if (isVariableDeclaration(declaration)) {
      declaration.declarations.forEach((declarator, index) => {
        const name = nameOf(declarator.id);
        if (name) add(name, { node, declaration, declaratorIndex: index });
      });
      return;
    }
    const id = (declaration as { id?: Node | null }).id;
    const name = nameOf(id);
    if (name) add(name, { node, declaration, declaratorIndex: -1 });
  };

  for (const statement of program.body) {
    if (isExportNamed(statement) && statement.declaration) {
      record(statement, statement.declaration);
      continue;
    }
    record(statement, statement);
  }

  return declared;
};

/** Names this module exports from its own declarations, exported name -> local. */
const collectExportedNames = (program: Program): Map<string, string> => {
  const exported = new Map<string, string>();

  for (const statement of program.body) {
    if (!isExportNamed(statement)) continue;

    if (statement.declaration) {
      const declaration = statement.declaration;
      if (isVariableDeclaration(declaration)) {
        for (const declarator of declaration.declarations) {
          const name = nameOf(declarator.id);
          if (name) exported.set(name, name);
        }
      } else {
        const name = nameOf((declaration as { id?: Node | null }).id);
        if (name) exported.set(name, name);
      }
      continue;
    }

    if (statement.source) continue;

    for (const specifier of statement.specifiers) {
      const local = nameOf(specifier.local);
      const alias = nameOf(specifier.exported);
      if (local && alias) exported.set(alias, local);
    }
  }

  return exported;
};

const membersOf = (
  source: string,
  declaration: Node,
  docFor: (start: number) => Comment | undefined,
  render: (md: string) => string,
  lineAt: (offset: number) => number,
): DocMember[] => {
  const body = (declaration as { body?: { body?: readonly ClassMember[] } })
    .body;
  const list = body?.body;
  if (!Array.isArray(list)) return [];

  const members: DocMember[] = [];
  for (const member of list) {
    if (member.type === 'StaticBlock' || isHidden(member)) continue;
    const name = memberName(member);
    if (name === undefined) continue;

    const comment = docFor(member.start);
    members.push({
      name,
      kind: memberKind(member),
      signature: memberSignature(source, member),
      doc: comment ? parseJsdoc(comment.value, render) : null,
      isStatic: member.static === true,
      optional: member.optional === true,
      line: lineAt(member.start),
    });
  }
  return members;
};

const kindOf = (
  declaration: Node,
  declaratorIndex: number,
): SymbolKind | null => {
  if (isClassDeclaration(declaration)) return SymbolKind.Class;
  if (isFunctionDeclaration(declaration)) return SymbolKind.Function;
  if (isInterfaceDeclaration(declaration)) return SymbolKind.Interface;
  if (isTypeAlias(declaration)) return SymbolKind.Type;
  if (isVariableDeclaration(declaration)) {
    const declarator = declaration.declarations[declaratorIndex];
    return declarator && isFunctionInitialised(declarator)
      ? SymbolKind.Function
      : SymbolKind.Variable;
  }
  return null;
};

const signatureOf = (
  source: string,
  declaration: Node,
  declaratorIndex: number,
): string => {
  if (isClassDeclaration(declaration))
    return classSignature(source, declaration);
  if (isFunctionDeclaration(declaration))
    return functionSignature(source, declaration);
  if (isInterfaceDeclaration(declaration))
    return interfaceSignature(source, declaration);
  if (isTypeAlias(declaration)) return typeAliasSignature(source, declaration);
  if (isVariableDeclaration(declaration))
    return variableSignature(source, declaration, declaratorIndex);
  return '';
};

const isDeprecated = (doc: DocComment | null): boolean =>
  doc?.tags.some((tag) => tag.name === 'deprecated') === true;

/**
 * Every symbol a module declares and exports. Re-exports (`export { x } from`)
 * carry no declaration here - they are resolved by the surface graph, which
 * points them back at the module that does declare them.
 */
export const collectSymbols = (
  file: string,
  source: string,
  program: Program,
  comments: readonly Comment[],
  render: (md: string) => string,
): FileSymbols => {
  const docFor = createDocFinder(source, comments);
  const lineAt = lineIndex(source);
  const declared = collectDeclarations(program);
  const exported = collectExportedNames(program);

  const symbols: DocSymbol[] = [];

  for (const [name, local] of exported) {
    const entries = (declared.get(local) ?? []).filter(
      (entry) => kindOf(entry.declaration, entry.declaratorIndex) !== null,
    );
    const primary = entries.find(
      (entry) =>
        kindOf(entry.declaration, entry.declaratorIndex) !== SymbolKind.Type,
    );
    const head = primary ?? entries[0];
    if (!head) continue;

    const comment = entries
      .map((entry) => docFor(entry.node.start))
      .find((found) => found !== undefined);
    const doc = comment ? parseJsdoc(comment.value, render) : null;

    symbols.push({
      name,
      kind:
        kindOf(head.declaration, head.declaratorIndex) ?? SymbolKind.Variable,
      signature: entries
        .map((entry) =>
          signatureOf(source, entry.declaration, entry.declaratorIndex),
        )
        .join('\n'),
      doc,
      members: entries.flatMap((entry) =>
        membersOf(source, entry.declaration, docFor, render, lineAt),
      ),
      file,
      line: lineAt(head.declaration.start),
      subpaths: [],
      deprecated: isDeprecated(doc),
    });
  }

  symbols.sort((a, b) => a.name.localeCompare(b.name));
  return { symbols };
};
