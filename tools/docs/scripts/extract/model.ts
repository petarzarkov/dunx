export const SymbolKind = Object.freeze({
  Class: 'class',
  Function: 'function',
  Interface: 'interface',
  Type: 'type',
  Variable: 'variable',
} as const);
export type SymbolKind = (typeof SymbolKind)[keyof typeof SymbolKind];

export const MemberKind = Object.freeze({
  Constructor: 'constructor',
  Method: 'method',
  Property: 'property',
  Accessor: 'accessor',
} as const);
export type MemberKind = (typeof MemberKind)[keyof typeof MemberKind];

export interface DocTag {
  readonly name: string;
  readonly text: string;
}

export interface DocComment {
  /** Markdown, already rendered to HTML. */
  readonly summary: string;
  readonly tags: readonly DocTag[];
}

export interface DocMember {
  readonly name: string;
  readonly kind: MemberKind;
  readonly signature: string;
  readonly doc: DocComment | null;
  readonly isStatic: boolean;
  readonly optional: boolean;
  readonly line: number;
}

export interface DocSymbol {
  readonly name: string;
  readonly kind: SymbolKind;
  readonly signature: string;
  readonly doc: DocComment | null;
  readonly members: readonly DocMember[];
  /** Repo-relative, e.g. `packages/core/src/container.ts`. */
  readonly file: string;
  readonly line: number;
  /** Public subpaths re-exporting it (`.`, `./db`). Empty means internal. */
  readonly subpaths: readonly string[];
  readonly deprecated: boolean;
}

export interface PackageDoc {
  readonly name: string;
  readonly dir: string;
  readonly description: string;
  readonly readme: string;
  readonly subpaths: readonly string[];
  readonly symbols: readonly DocSymbol[];
}

export interface GuidePage {
  readonly slug: string;
  readonly title: string;
  /** Repo-relative path the page was rendered from. */
  readonly source: string;
  readonly html: string;
  readonly headings: readonly { readonly id: string; readonly text: string }[];
}

export interface CoverageFile {
  readonly path: string;
  readonly lines: number;
  readonly linesHit: number;
  readonly funcs: number;
  readonly funcsHit: number;
  readonly uncovered: string;
}

export interface CoveragePackage {
  readonly name: string;
  readonly lines: number;
  readonly linesHit: number;
  readonly funcs: number;
  readonly funcsHit: number;
  readonly files: readonly CoverageFile[];
}

export interface CoverageModel {
  readonly generatedAt: string;
  readonly commit: string | null;
  readonly totals: {
    readonly lines: number;
    readonly linesHit: number;
    readonly funcs: number;
    readonly funcsHit: number;
  };
  readonly packages: readonly CoveragePackage[];
  readonly untested: readonly string[];
}

export interface SiteModel {
  readonly generatedAt: string;
  readonly repoUrl: string;
  readonly packages: readonly PackageDoc[];
  readonly guides: readonly GuidePage[];
  readonly home: string;
}
