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
    // The identifier rides along so the boot error can say which import to
    // change: the annotation alone reads the same as an interface's.
    expect(entriesFor(source, 'Service')).toBe(
      '{ unresolved: "private readonly config: Config", typeOnly: "Config" }',
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

describe('type-only imports that are not named specifiers', () => {
  it('marks a default type import as unresolved', () => {
    const source = `import type Config from './config.js';
export class Service {
  constructor(private readonly config: Config) {}
}`;
    expect(entriesFor(source, 'Service')).toBe(
      '{ unresolved: "private readonly config: Config", typeOnly: "Config" }',
    );
  });

  it('marks a namespace type import as unresolved', () => {
    const source = `import type * as schema from './schema.js';
export class Service {
  constructor(private readonly row: schema.Row) {}
}`;
    expect(entriesFor(source, 'Service')).toBe(
      '{ unresolved: "private readonly row: schema.Row", typeOnly: "schema" }',
    );
  });
});

describe('qualified type names', () => {
  it('keeps a qualified name whose namespace is a value import', () => {
    const source = `import * as infra from './infra.js';
export class Service {
  constructor(private readonly db: infra.Db) {}
}`;
    expect(entriesFor(source, 'Service')).toBe('infra.Db');
  });

  it('keeps a deeply qualified name whose root is a value import', () => {
    const source = `import * as infra from './infra.js';
export class Service {
  constructor(private readonly db: infra.nested.Db) {}
}`;
    expect(entriesFor(source, 'Service')).toBe('infra.nested.Db');
  });

  it('marks a qualified name whose root was imported with import type', () => {
    const source = `import type { infra } from './infra.js';
export class Service {
  constructor(private readonly db: infra.Db) {}
}`;
    expect(entriesFor(source, 'Service')).toBe(
      '{ unresolved: "private readonly db: infra.Db", typeOnly: "infra" }',
    );
  });
});

describe('a type sharing a name with a runtime value', () => {
  it('keeps a class that an interface in the same file merges into', () => {
    const source = `export class Logger {}
export interface Logger { extra(): void }
export class Service {
  constructor(private readonly logger: Logger) {}
}`;
    expect(entriesFor(source, 'Service')).toBe('Logger');
  });

  it('still erases an interface sharing a name with a const', () => {
    const source = `const Logger = { level: 'info' };
interface Logger { extra(): void }
export class Service {
  constructor(private readonly logger: Logger) {}
}`;
    expect(entriesFor(source, 'Service')).toContain('unresolved');
  });
});

describe('parameters with a default', () => {
  it('injects a defaulted parameter whose type is a runtime value', () => {
    const source = `import { Db } from './db.js';
export class Service {
  constructor(private readonly db: Db = new Db()) {}
}`;
    expect(entriesFor(source, 'Service')).toBe('Db');
  });

  it('leaves a defaulted parameter with an erased type to its default', () => {
    const source = `export class Service {
  constructor(private readonly retries: number = 3) {}
}`;
    expect(entriesFor(source, 'Service')).toBe(
      '{ unresolved: "private readonly retries: number = 3", optional: true }',
    );
  });

  it('mixes an injected dependency with a defaulted one', () => {
    const source = `import { Db } from './db.js';
export class Service {
  constructor(
    private readonly db: Db,
    private readonly retries: number = 3,
  ) {}
}`;
    expect(entriesFor(source, 'Service')).toContain('Db, { unresolved');
  });

  it('leaves a defaulted parameter with no type at all to its default', () => {
    const source = `export class Service {
  constructor(private readonly retries = 3) {}
}`;
    expect(entriesFor(source, 'Service')).toContain('optional: true');
  });
});

describe('parameters dunx cannot inject', () => {
  // A rest parameter has no single type to resolve, so it is reported at boot
  // rather than silently receiving nothing.
  it('marks a rest parameter as unresolved', () => {
    const source = `export class Service {
  constructor(...args: string[]) { void args; }
}`;
    const entries = entriesFor(source, 'Service');
    expect(entries).toContain('unresolved');
    expect(entries).not.toContain('optional');
  });

  it('marks a destructured parameter as unresolved', () => {
    const source = `import { Options } from './options.js';
export class Service {
  constructor({ retries }: Options) { void retries; }
}`;
    expect(entriesFor(source, 'Service')).toContain('unresolved');
  });
});

describe('line numbers', () => {
  it('adds no lines, so a stack trace still points at the original', () => {
    const source = `import { D } from './d.js';
class A { constructor(a: D) { void a; } }
class B { constructor(b: D) { void b; } }
class C {
  constructor(c: D) { void c; }
  boom() { throw new Error('from C.boom'); }
}`;
    const { code } = transform(source, 'x.ts');
    const lineOf = (text: string, needle: string): number =>
      text.split('\n').findIndex((line) => line.includes(needle)) + 1;

    expect(code.split('\n').length).toBe(source.split('\n').length);
    expect(lineOf(code, 'from C.boom')).toBe(lineOf(source, 'from C.boom'));
  });
});
