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
  // Both classes in `SOURCES` have empty constructors, so the old `) {}` pattern
  // worked and would have broken silently on the third one added.
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
