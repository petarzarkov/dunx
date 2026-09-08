import { afterEach, describe, expect, it } from 'bun:test';
import { assemble, main } from './cli.js';

const PACKAGE = `${import.meta.dir}/..`;
const CLI = `${import.meta.dir}/cli.ts`;

const errors: string[] = [];
const real = console.error;

const capture = (): void => {
  console.error = (...args: unknown[]) =>
    errors.push(args.map(String).join(' '));
};

afterEach(() => {
  console.error = real;
  errors.length = 0;
});

/**
 * The argument handling, in process. The success path is not testable this way -
 * it hands `Bun.stdin.stream()` to `serve` and blocks - so it is a subprocess
 * below.
 */
describe('the command line', () => {
  it('prints usage and succeeds on --help', async () => {
    capture();
    expect(await main(['--help'])).toBe(0);
    expect(errors.join('\n')).toContain('Usage: bunx @dunx/mcp');
  });

  it('prints the version and succeeds on --version', async () => {
    capture();
    expect(await main(['--version'])).toBe(0);
    expect(errors[0]).toMatch(/^\d+\.\d+\.\d+/);
  });

  /**
   * It used to print usage and exit 1. Someone adopting dunx has no root module to
   * point at, so the one moment the guide tools are worth most was the one moment
   * the server refused to start.
   */
  it('serves the tools that need no app when given no entry', async () => {
    capture();
    const tools = await assemble([]);
    if (typeof tools === 'number') throw new Error('assemble refused to start');
    expect(tools.map((tool) => tool.name)).toEqual([
      'dunx_start',
      'dunx_guide',
      'dunx_scaffold',
    ]);
    expect(errors.join('\n')).toContain('No entry given');
  });

  it('adds the readers to them when given one', async () => {
    const tools = await assemble([`${import.meta.dir}/app.fixture.ts`]);
    if (typeof tools === 'number') throw new Error('assemble refused to start');
    expect(tools.map((tool) => tool.name)).toContain('dunx_start');
    expect(tools.map((tool) => tool.name)).toContain('dunx_routes');
  });

  it('names the entry and the directory when it cannot be resolved', async () => {
    capture();
    expect(await main(['./does-not-exist.ts'])).toBe(1);
    expect(errors.join('\n')).toContain('Cannot resolve ./does-not-exist.ts');
  });

  it('reports an entry that declares no module at all', async () => {
    capture();
    expect(await main([`${import.meta.dir}/protocol.ts`])).toBe(1);
    expect(errors.join('\n')).toContain('exports no @Module class');
  });

  it('rejects an --export that names no module', async () => {
    capture();
    expect(
      await main([`${import.meta.dir}/app.fixture.ts`, '--export=Clock']),
    ).toBe(1);
    expect(errors.join('\n')).toContain('no exported @Module named `Clock`');
  });

  /**
   * The resolution fix. `startsWith('.') ? cwd + entry : entry` treated a bare
   * relative path as a package specifier, so `bunx @dunx/mcp src/app.module.ts`
   * failed to find a file that was plainly there. `Bun.resolveSync` is the
   * runtime's own resolver, so every specifier `import` accepts works.
   */
  it('resolves a relative path with no leading ./', async () => {
    capture();
    const cwd = process.cwd();
    process.chdir(PACKAGE);
    try {
      // Resolves, loads, and gets as far as the root-module check, which is proof
      // it was found: an unresolvable entry fails with a different message.
      expect(await main(['src/protocol.ts'])).toBe(1);
      expect(errors.join('\n')).toContain('exports no @Module class');
      expect(errors.join('\n')).not.toContain('Cannot resolve');
    } finally {
      process.chdir(cwd);
    }
  });
});

/**
 * The real thing: a spawned server speaking newline-delimited JSON-RPC over stdio.
 * This is what exercises `Bun.stdin.stream()`, the `Bun.stdout.writer()` sink and
 * its per-message flush - a buffered write with no flush would leave a client
 * waiting forever, and no in-process test of `serve` would notice.
 */
describe('the server over stdio', () => {
  const ask = async (
    requests: readonly Record<string, unknown>[],
    /** `null` runs it with no entry at all, which is a supported invocation. */
    entry: string | null = 'src/app.fixture.ts',
  ): Promise<Record<string, unknown>[]> => {
    const proc = Bun.spawn(
      entry === null ? ['bun', CLI] : ['bun', CLI, entry],
      {
        cwd: PACKAGE,
        stdin: 'pipe',
        stdout: 'pipe',
        stderr: 'pipe',
      },
    );

    for (const request of requests) {
      void proc.stdin.write(
        `${JSON.stringify({ jsonrpc: '2.0', ...request })}\n`,
      );
    }
    await proc.stdin.end();

    const out = await new Response(proc.stdout).text();
    expect(await proc.exited).toBe(0);

    return out
      .split('\n')
      .filter((line) => line !== '')
      .map((line) => JSON.parse(line) as Record<string, unknown>);
  };

  /** The first answer, asserted present so the reads below are not optional. */
  const first = async (
    requests: readonly Record<string, unknown>[],
    entry?: string | null,
  ): Promise<Record<string, unknown>> => {
    const [answer] =
      entry === undefined ? await ask(requests) : await ask(requests, entry);
    if (!answer) throw new Error('the server answered nothing');
    return answer;
  };

  it('completes a handshake and lists its tools', async () => {
    const answers = await ask([
      { id: 1, method: 'initialize' },
      { method: 'notifications/initialized' },
      { id: 2, method: 'tools/list' },
    ]);

    // The notification is not answered, so there are two lines, not three.
    expect(answers).toHaveLength(2);
    const handshake = answers[0];
    if (!handshake) throw new Error('the server did not answer initialize');
    const init = handshake['result'] as {
      protocolVersion: string;
      serverInfo: { name: string };
    };
    expect(init.protocolVersion).toBeString();
    expect(init.serverInfo.name).toBe('@dunx/mcp');

    const list = answers[1];
    if (!list) throw new Error('the server did not answer tools/list');
    expect(list['id']).toBe(2);
    const { tools } = list['result'] as { tools: { name: string }[] };
    expect(tools.map((tool) => tool.name)).toContain('dunx_routes');
  }, 20_000);

  it('answers a ping, which a client uses as a liveness check', async () => {
    const pong = await first([{ id: 1, method: 'ping' }]);
    expect(pong['result']).toEqual({});
    expect(pong).not.toHaveProperty('error');
  }, 20_000);

  it('reads the app and answers a tool call, without booting it', async () => {
    const answer = await first([
      { id: 1, method: 'tools/call', params: { name: 'dunx_routes' } },
    ]);

    const { content } = answer['result'] as {
      content: { type: string; text: string }[];
    };
    expect(content[0]?.type).toBe('text');
    const { routes } = JSON.parse(content[0]?.text ?? '{}') as {
      routes: { path: string }[];
    };
    expect(routes.map((route) => route.path).sort()).toEqual([
      '/health',
      '/notes',
      '/notes',
    ]);
  }, 20_000);

  /**
   * `@dunx/create-app`'s template, and every example in this repo, ends
   * `export class AppModule {}` - a named export and nothing else. Requiring
   * `default` or `root` meant the first thing anyone would try failed on a freshly
   * scaffolded app; the `@Module` marker makes the root recognisable instead.
   */
  it('finds a root module exported only by name', async () => {
    const answer = await first(
      [{ id: 1, method: 'tools/call', params: { name: 'dunx_routes' } }],
      'src/named-only.fixture.ts',
    );
    const { content } = answer['result'] as { content: { text: string }[] };
    const { routes } = JSON.parse(content[0]?.text ?? '{}') as {
      routes: { path: string; controller: string }[];
    };
    expect(routes).toHaveLength(1);
    expect(routes[0]?.path).toBe('/ping');
    expect(routes[0]?.controller).toBe('PingController');
  }, 20_000);

  it('starts with no entry, serving the guide as tools and as resources', async () => {
    const answers = await ask(
      [
        { id: 1, method: 'tools/list' },
        { id: 2, method: 'resources/list' },
      ],
      null,
    );

    const list = answers[0];
    if (!list) throw new Error('the server did not answer tools/list');
    const { tools } = list['result'] as { tools: { name: string }[] };
    const names = tools.map((tool) => tool.name);
    expect(names).toContain('dunx_start');
    // Nothing was given to read, so the readers must not be advertised.
    expect(names).not.toContain('dunx_routes');

    const listed = answers[1];
    if (!listed) throw new Error('the server did not answer resources/list');
    const { resources } = listed['result'] as { resources: { uri: string }[] };
    expect(resources.length).toBeGreaterThan(20);
    expect(resources[0]?.uri).toStartWith('dunx://guide/');
  }, 20_000);

  it('reads a guide chapter as a resource', async () => {
    const answer = await first(
      [
        {
          id: 1,
          method: 'resources/read',
          params: { uri: 'dunx://guide/02-first-steps' },
        },
      ],
      null,
    );
    const { contents } = answer['result'] as {
      contents: { text: string; mimeType: string }[];
    };
    expect(contents[0]?.mimeType).toBe('text/markdown');
    expect(contents[0]?.text).toContain('# First steps');
  }, 20_000);

  it('accepts a relative entry with no leading ./ from the shell', async () => {
    const answer = await first(
      [{ id: 1, method: 'tools/call', params: { name: 'dunx_overview' } }],
      'src/app.fixture.ts',
    );
    const { content } = answer['result'] as { content: { text: string }[] };
    expect(JSON.parse(content[0]?.text ?? '{}')).toMatchObject({ routes: 3 });
  }, 20_000);
});
