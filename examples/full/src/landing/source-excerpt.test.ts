import { expect, it } from 'bun:test';
import { constructorExcerpt } from './source-excerpt.js';

it('keeps the class line and the constructor, and drops what is between', () => {
  const source = [
    "import { Logger } from '@dunx/core';",
    '',
    'export class Ledger implements OnInit {',
    '  /**',
    '   * A paragraph the panel should not show.',
    '   */',
    '  constructor(',
    '    private readonly db: SyncDatabase<typeof schema>,',
    '    private readonly logger: Logger,',
    '  ) {}',
    '',
    '  list(): void {}',
    '}',
  ].join('\n');

  expect(constructorExcerpt(source)).toBe(
    [
      'export class Ledger implements OnInit {',
      '  constructor(',
      '    private readonly db: SyncDatabase<typeof schema>,',
      '    private readonly logger: Logger,',
      '  ) {}',
    ].join('\n'),
  );
});

it('cuts a constructor that has a body, rather than truncating to the class', () => {
  // Both classes in `SOURCES` are empty-bodied, so `) {}` worked until a third.
  const source = [
    'export class Workspace {',
    '  constructor(',
    '    private readonly root: string,',
    '  ) {',
    '    this.root = root;',
    '  }',
    '}',
  ].join('\n');

  expect(constructorExcerpt(source)).toBe(
    [
      'export class Workspace {',
      '  constructor(',
      '    private readonly root: string,',
      '  ) {',
    ].join('\n'),
  );
});

it('keeps a single-line constructor whole', () => {
  const source = [
    'export class Thin {',
    '  constructor(private readonly logger: Logger) {}',
    '}',
  ].join('\n');

  expect(constructorExcerpt(source)).toBe(
    [
      'export class Thin {',
      '  constructor(private readonly logger: Logger) {}',
    ].join('\n'),
  );
});

it('yields the declaration alone for a class with no constructor', () => {
  const source = ['export class Bare {', '  run(): void {}', '}'].join('\n');

  expect(constructorExcerpt(source)).toBe('export class Bare {');
});

it('yields nothing when there is no exported class', () => {
  expect(constructorExcerpt('const x = 1;\n')).toBe('');
});

it('does not borrow a later class constructor for an earlier one', () => {
  // The search ran to the end of the file, so the wrong constructor was shown.
  const source = [
    'export class Marker {',
    '  run(): void {}',
    '}',
    '',
    'export class Real {',
    '  constructor(private readonly logger: Logger) {}',
    '}',
  ].join('\n');

  expect(constructorExcerpt(source)).toBe('export class Marker {');
});

it('is not bounded by a brace that closes at column zero', () => {
  // A column-0 `}` cut the search off above the constructor, and the panel fell
  // back to the class line.
  const source = [
    'export class Wide {',
    '  readonly shape = {',
    '    a: 1,',
    '};',
    '',
    '  constructor(private readonly logger: Logger) {}',
    '}',
  ].join('\n');

  expect(constructorExcerpt(source)).toBe(
    [
      'export class Wide {',
      '  constructor(private readonly logger: Logger) {}',
    ].join('\n'),
  );
});
