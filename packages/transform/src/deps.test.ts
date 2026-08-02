import { describe, expect, it } from 'bun:test';
import { transform } from './deps.js';

/** The dependency list the transform recorded for one class. */
const entriesFor = (source: string, klass: string): string => {
  const { code } = transform(source, 'fixture.ts');
  const marker = `Object.defineProperty(${klass}, Symbol.for('dunx.deps'), {`;
  const at = code.indexOf(marker);
  if (at === -1) return '';

  const open = code.indexOf('[', at);
  const close = code.indexOf(']', open);
  return code.slice(open + 1, close);
};

describe('resolvable parameters', () => {
  it('uses the parameter type as the token', () => {
    const source = `import { Repo } from './repo.js';
export class Service {
  constructor(private readonly repo: Repo) {}
}`;
    expect(entriesFor(source, 'Service')).toBe('Repo');
  });

  it('handles a plain parameter with no accessibility modifier', () => {
    const source = `import { Repo } from './repo.js';
export class Service {
  constructor(repo: Repo) { void repo; }
}`;
    expect(entriesFor(source, 'Service')).toBe('Repo');
  });

  it('keeps parameter order across several dependencies', () => {
    const source = `import { A } from './a.js';
import { B } from './b.js';
import { C } from './c.js';
export class Service {
  constructor(
    private readonly c: C,
    private readonly a: A,
    protected readonly b: B,
  ) {}
}`;
    expect(entriesFor(source, 'Service')).toBe('C, A, B');
  });

  it('uses the bare name of a generic type', () => {
    const source = `import { Repository } from './repo.js';
export class Service {
  constructor(private readonly repo: Repository<User>) {}
}`;
    expect(entriesFor(source, 'Service')).toBe('Repository');
  });

  it('annotates an abstract class so subclasses inherit its record', () => {
    const source = `import { Db } from './db.js';
export abstract class Base {
  constructor(protected readonly db: Db) {}
}`;
    expect(entriesFor(source, 'Base')).toBe('Db');
  });
});

describe('erased parameters', () => {
  it('marks a type-only import as unresolved', () => {
    const source = `import type { Config } from './config.js';
export class Service {
  constructor(private readonly config: Config) {}
}`;
    expect(entriesFor(source, 'Service')).toBe(
      '{ unresolved: "private readonly config: Config" }',
    );
  });

  it('marks an inline type specifier as unresolved', () => {
    const source = `import { Db, type Row } from './db.js';
export class Service {
  constructor(private readonly row: Row) {}
}`;
    expect(entriesFor(source, 'Service')).toContain('unresolved');
  });

  it('marks a local interface as unresolved', () => {
    const source = `interface Shape { a: string }
export class Service {
  constructor(private readonly shape: Shape) {}
}`;
    expect(entriesFor(source, 'Service')).toContain('unresolved');
  });

  it('marks a local type alias as unresolved', () => {
    const source = `type Alias = { a: string };
export class Service {
  constructor(private readonly alias: Alias) {}
}`;
    expect(entriesFor(source, 'Service')).toContain('unresolved');
  });

  it('marks primitives and unions as unresolved', () => {
    const source = `export class Service {
  constructor(
    private readonly count: number,
    private readonly label: string,
    private readonly mode: 'a' | 'b',
  ) {}
}`;
    const entries = entriesFor(source, 'Service');
    expect(entries).toContain('count: number');
    expect(entries).toContain('label: string');
    expect(entries).toContain("mode: 'a' | 'b'");
    expect(entries).not.toContain('number,');
  });

  it("marks the class's own type parameter as unresolved", () => {
    const source = `import { Db } from './db.js';
export class Box<T> {
  constructor(private readonly item: T, private readonly db: Db) {}
}`;
    expect(entriesFor(source, 'Box')).toBe(
      '{ unresolved: "private readonly item: T" }, Db',
    );
  });

  it('marks an untyped parameter as unresolved', () => {
    const source = `export class Service {
  constructor(private readonly thing) {}
}`;
    expect(entriesFor(source, 'Service')).toContain('unresolved');
  });
});

describe('classes left alone', () => {
  it('skips a class with no constructor', () => {
    const source = `export class Plain { value = 1; }`;
    expect(transform(source, 'x.ts').changed).toBe(false);
  });

  it('skips a constructor with no parameters', () => {
    const source = `export class Plain { constructor() { this.x = 1; } }`;
    expect(transform(source, 'x.ts').changed).toBe(false);
  });

  it('skips a class expression, whose name is not in scope outside it', () => {
    const source = `import { Db } from './db.js';
const Holder = class Inner {
  constructor(private readonly db: Db) {}
};
void Holder;`;
    const result = transform(source, 'x.ts');
    expect(result.changed).toBe(false);
    expect(result.annotated).toEqual([]);
  });
});

describe('emitted shape', () => {
  it('records the dependency list behind a thunk, not an array literal', () => {
    const source = `import { Repo } from './repo.js';
export class Service {
  constructor(private readonly repo: Repo) {}
}`;
    expect(transform(source, 'x.ts').code).toContain('value: () => [Repo]');
  });

  it('appends after the class so the binding is initialized', () => {
    const source = `import { Repo } from './repo.js';
export class Service {
  constructor(private readonly repo: Repo) {}
}`;
    const { code } = transform(source, 'x.ts');
    expect(code.indexOf('class Service')).toBeLessThan(
      code.indexOf('Object.defineProperty(Service'),
    );
  });

  it('leaves the original source bytes untouched', () => {
    const source = `import { Repo } from './repo.js';
// a comment that must survive
export class Service {
  constructor(private readonly repo: Repo) {}
}`;
    const { code } = transform(source, 'x.ts');
    expect(code.startsWith(source)).toBe(true);
  });

  it('reports every annotated class in source order', () => {
    const source = `import { A } from './a.js';
export class One { constructor(a: A) { void a; } }
export class Two { constructor(a: A) { void a; } }
export class Three { value = 1; }`;
    expect(transform(source, 'x.ts').annotated).toEqual(['One', 'Two']);
  });

  it('annotates several classes in one file independently', () => {
    const source = `import { A } from './a.js';
import type { B } from './b.js';
export class One { constructor(a: A) { void a; } }
export class Two { constructor(b: B) { void b; } }`;
    expect(entriesFor(source, 'One')).toBe('A');
    expect(entriesFor(source, 'Two')).toContain('unresolved');
  });
});

describe('failures', () => {
  it('throws with the filename when the source does not parse', () => {
    expect(() => transform('class {{{', 'broken.ts')).toThrow(
      /broken\.ts: could not parse/,
    );
  });
});
