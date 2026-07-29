import { afterAll, describe, expect, it } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { transform } from './deps.js';
import {
  FIELDS_SYMBOL_KEY,
  isUnresolvedField,
  type FieldRecord,
} from './fields.js';

/** The field record the transform wrote for one class. */
const fieldsFor = (source: string, klass: string): string => {
  const { code } = transform(source, 'fixture.ts');
  const marker = `Object.defineProperty(${klass}, Symbol.for('dunx.fields'), {`;
  const at = code.indexOf(marker);
  if (at === -1) return '';

  const open = code.indexOf('({', at);
  const close = code.indexOf('})', open);
  return code.slice(open + 2, close).trim();
};

/** The record as the reader sees it, by evaluating the emitted thunk. */
const readRecord = (
  source: string,
  klass: string,
): Record<string, Record<string, unknown>> => {
  const { code } = transform(source, 'fixture.ts');
  const body = code.slice(code.indexOf(`class ${klass}`));
  const thunk = body.slice(
    body.indexOf('value: () => (') + 'value: () => ('.length,
    body.lastIndexOf('),'),
  );
  return JSON.parse(
    thunk.replaceAll(/(\w+):/g, '"$1":').replaceAll('""', '"'),
  ) as Record<string, Record<string, unknown>>;
};

const entity = (body: string): string =>
  `@Entity('t')\nexport class Row {\n${body}\n}`;

describe('resolvable field types', () => {
  it('records a keyword annotation as its written type', () => {
    const source = entity(
      '  @Column() name!: string;\n' +
        '  @Column() count!: number;\n' +
        '  @Column() active!: boolean;\n' +
        '  @Column() big!: bigint;',
    );
    const record = readRecord(source, 'Row');
    expect(record['name']).toEqual({ type: 'string' });
    expect(record['count']).toEqual({ type: 'number' });
    expect(record['active']).toEqual({ type: 'boolean' });
    expect(record['big']).toEqual({ type: 'bigint' });
  });

  it('records a global class annotation by name', () => {
    const source = entity(
      '  @Column() joined!: Date;\n  @Column() bytes!: Uint8Array;',
    );
    const record = readRecord(source, 'Row');
    expect(record['joined']).toEqual({ type: 'Date' });
    expect(record['bytes']).toEqual({ type: 'Uint8Array' });
  });

  it('records `?` as optional', () => {
    expect(
      readRecord(entity('  @PrimaryKey() id?: number;'), 'Row')['id'],
    ).toEqual({ type: 'number', optional: true });
  });

  it('records `T | null` as nullable', () => {
    expect(
      readRecord(entity('  @Column() email!: string | null;'), 'Row')['email'],
    ).toEqual({ type: 'string', nullable: true });
  });

  it('reads `null | T` written the other way round', () => {
    expect(
      readRecord(entity('  @Column() email!: null | string;'), 'Row')['email'],
    ).toEqual({ type: 'string', nullable: true });
  });

  it('keeps declaration order', () => {
    const source = entity(
      '  @Column() c!: string;\n  @Column() a!: string;\n  @Column() b!: string;',
    );
    expect(Object.keys(readRecord(source, 'Row'))).toEqual(['c', 'a', 'b']);
  });

  it('records fields on a class that also has constructor dependencies', () => {
    const source = `import { Db } from './db.js';
export class Both {
  @Column() name!: string;
  constructor(private readonly db: Db) {}
}`;
    const { code, annotated, fielded } = transform(source, 'x.ts');
    expect(annotated).toEqual(['Both']);
    expect(fielded).toEqual(['Both']);
    expect(code).toContain("Symbol.for('dunx.deps')");
    expect(code).toContain("Symbol.for('dunx.fields')");
  });
});

describe('erased field types', () => {
  it('marks a type-only import as unresolved, naming the field', () => {
    const source = `import type { Meta } from './meta.js';
${entity('  @Column() meta!: Meta;')}`;
    expect(readRecord(source, 'Row')['meta']).toEqual({
      unresolved: 'meta!: Meta',
    });
  });

  it('marks an inline type specifier as unresolved', () => {
    const source = `import { Db, type Meta } from './db.js';
${entity('  @Column() meta!: Meta;')}`;
    expect(fieldsFor(source, 'Row')).toContain('unresolved');
  });

  it('marks a local interface as unresolved', () => {
    const source = `interface Meta { a: string }
${entity('  @Column() meta!: Meta;')}`;
    expect(fieldsFor(source, 'Row')).toContain('unresolved');
  });

  it('marks a local type alias as unresolved', () => {
    const source = `type Meta = { a: string };
${entity('  @Column() meta!: Meta;')}`;
    expect(fieldsFor(source, 'Row')).toContain('unresolved');
  });

  it('marks a literal union as unresolved', () => {
    expect(
      readRecord(entity("  @Column() mode!: 'a' | 'b';"), 'Row')['mode'],
    ).toEqual({ unresolved: "mode!: 'a' | 'b'" });
  });

  it('marks a union of more than one non-null member as unresolved', () => {
    expect(
      fieldsFor(entity('  @Column() x!: string | number | null;'), 'Row'),
    ).toContain('unresolved');
  });

  it('marks a generic type reference as unresolved', () => {
    expect(
      fieldsFor(entity('  @Column() bag!: Record<string, string>;'), 'Row'),
    ).toContain('unresolved');
  });

  it('marks an array type as unresolved', () => {
    expect(fieldsFor(entity('  @Column() tags!: string[];'), 'Row')).toContain(
      'unresolved',
    );
  });

  it('marks an unannotated field as unresolved', () => {
    expect(fieldsFor(entity('  @Column() loose = 1;'), 'Row')).toContain(
      'unresolved',
    );
  });

  it("marks the class's own type parameter as unresolved", () => {
    const source = `export class Box<T> {
  @Column() item!: T;
  @Column() name!: string;
}`;
    const record = readRecord(source, 'Box');
    expect(record['item']).toEqual({ unresolved: 'item!: T' });
    expect(record['name']).toEqual({ type: 'string' });
  });
});

describe('fields left alone', () => {
  it('records nothing for a class with no decorated field', () => {
    const source = `export class Plain {
  name = 'a';
  count = 1;
}`;
    const result = transform(source, 'x.ts');
    expect(result.changed).toBe(false);
    expect(result.fielded).toEqual([]);
  });

  it('skips an undecorated field on an entity', () => {
    const source = entity('  @Column() name!: string;\n  helper = 1;');
    expect(Object.keys(readRecord(source, 'Row'))).toEqual(['name']);
  });

  it('skips a static field', () => {
    const source = entity(
      '  @Column() name!: string;\n  @Column() static table = 1;',
    );
    expect(Object.keys(readRecord(source, 'Row'))).toEqual(['name']);
  });

  it('skips a computed key, which is not knowable at load time', () => {
    const source = entity(
      "  @Column() name!: string;\n  @Column() ['dyn']!: string;",
    );
    expect(Object.keys(readRecord(source, 'Row'))).toEqual(['name']);
  });

  it('skips a decorated method', () => {
    const source = `export class Controller {
  @Get() list() { return []; }
}`;
    expect(transform(source, 'x.ts').fielded).toEqual([]);
  });

  it('skips a class expression, whose name is not in scope outside it', () => {
    const source = `const Holder = class Inner {
  @Column() name!: string;
};
void Holder;`;
    const result = transform(source, 'x.ts');
    expect(result.changed).toBe(false);
    expect(result.fielded).toEqual([]);
  });
});

describe('emitted shape', () => {
  it('records the fields behind a thunk, not an object literal', () => {
    const { code } = transform(entity('  @Column() name!: string;'), 'x.ts');
    expect(code).toContain('value: () => ({');
  });

  it('appends after the class, so decorators cannot read it while they run', () => {
    const { code } = transform(entity('  @Column() name!: string;'), 'x.ts');
    expect(code.indexOf('class Row')).toBeLessThan(
      code.indexOf('Object.defineProperty(Row'),
    );
  });

  it('leaves the original source bytes untouched', () => {
    const source = `// a comment that must survive\n${entity('  @Column() name!: string;')}`;
    expect(transform(source, 'x.ts').code.startsWith(source)).toBe(true);
  });

  it('reports every class with fields in source order', () => {
    const source = `${entity('  @Column() a!: string;').replace('Row', 'One')}
${entity('  @Column() b!: string;').replace('Row', 'Two')}
export class Three { value = 1; }`;
    expect(transform(source, 'x.ts').fielded).toEqual(['One', 'Two']);
  });
});

/**
 * The emitted statement, actually run. Everything above reads the text; this
 * loads it, so the key, the thunk and the shape are checked against what a
 * consumer really sees rather than against a substring.
 */
describe('the record a consumer reads', () => {
  const dirs: string[] = [];

  afterAll(async () => {
    for (const dir of dirs) await rm(dir, { recursive: true, force: true });
  });

  const load = async (body: string): Promise<FieldRecord> => {
    const source = `const noop = () => () => {};
const Column = noop;
export class Row {
${body}
}`;
    const dir = await mkdtemp(join(tmpdir(), 'dunx-fields-'));
    dirs.push(dir);
    const file = join(dir, 'row.ts');
    await writeFile(file, transform(source, file).code);

    const loaded = (await import(file)) as {
      Row: Record<symbol, (() => FieldRecord) | undefined>;
    };
    const thunk = loaded.Row[Symbol.for(FIELDS_SYMBOL_KEY)];
    if (thunk === undefined) throw new Error('no record was written');
    return thunk();
  };

  it('exports the same key the transform writes', () => {
    const { code } = transform(entity('  @Column() name!: string;'), 'x.ts');
    expect(code).toContain(`Symbol.for('${FIELDS_SYMBOL_KEY}')`);
  });

  it('is readable off the class under that key, after decoration', async () => {
    const record = await load(
      '  @Column() name!: string;\n' +
        '  @Column() age?: number;\n' +
        '  @Column() email!: string | null;',
    );
    expect(record).toEqual({
      name: { type: 'string' },
      age: { type: 'number', optional: true },
      email: { type: 'string', nullable: true },
    });
  });

  it('hands an erased field back as unresolved, quoting the declaration', async () => {
    const record = await load(
      '  @Column() name!: string;\n  @Column() tags!: string[];',
    );
    const tags = record['tags'];
    const name = record['name'];
    if (tags === undefined || name === undefined) throw new Error('missing');

    expect(isUnresolvedField(tags)).toBe(true);
    expect(isUnresolvedField(name)).toBe(false);
    // Field name plus declaration: enough for the consumer's error to be precise.
    expect(tags).toEqual({ unresolved: 'tags!: string[]' });
  });
});
