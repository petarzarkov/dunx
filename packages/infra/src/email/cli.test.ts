import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import { relative as relativePath, resolve } from 'node:path';
import { loadRenderer, main, plan, type Plan } from './cli.js';
import { BodyRenderer, TemplateDir } from './templates.fixture.js';

const RENDERER = resolve(import.meta.dir, 'templates.fixture.ts');

const parsed = (...argv: string[]): Plan => {
  const result = plan(argv);
  if (typeof result === 'string') throw new Error(result);
  return result;
};

describe('plan', () => {
  it('defaults to previewing ./emails on 3035', () => {
    expect(parsed()).toEqual({
      command: 'preview',
      dir: resolve('emails'),
      out: resolve('out'),
      port: 3035,
      renderer: '@dunx/infra/email/react',
    });
  });

  it('takes the directory as a positional', () => {
    expect(parsed('preview', 'src/mail').dir).toBe(resolve('src/mail'));
  });

  it('takes the port, the out directory and the renderer as flags', () => {
    const result = parsed(
      'export',
      'src/mail',
      '--port',
      '4000',
      '--out',
      'dist/mail',
      '--renderer',
      './my-renderer.ts',
    );

    expect(result.command).toBe('export');
    expect(result.port).toBe(4000);
    expect(result.out).toBe(resolve('dist/mail'));
    expect(result.renderer).toBe('./my-renderer.ts');
  });

  it('prints the usage for --help', () => {
    expect(plan(['--help'])).toContain('dunx-email preview');
    expect(plan(['-h'])).toContain('dunx-email preview');
  });

  it('names an unknown command and shows the usage', () => {
    expect(plan(['send'])).toContain('Unknown command "send"');
  });

  // The hand-rolled split collected a flag's value as a positional, so this
  // served ./4000 instead of ./emails.
  it('keeps a flag value out of the directory', () => {
    expect(parsed('preview', '--port', '4000').dir).toBe(resolve('emails'));
    expect(parsed('preview', '--port', '4000').port).toBe(4000);
    expect(parsed('export', '--out', '/tmp/x').dir).toBe(resolve('emails'));
  });

  it('takes the directory whichever side of the flags it is on', () => {
    expect(parsed('preview', '--port', '4000', 'src/mail').dir).toBe(
      resolve('src/mail'),
    );
    expect(parsed('preview', 'src/mail', '--port', '4000').dir).toBe(
      resolve('src/mail'),
    );
  });

  it('names an unknown flag rather than ignoring it', () => {
    expect(plan(['preview', '--prot', '4000'])).toContain('--prot');
  });

  it('refuses a port that is not one', () => {
    expect(plan(['preview', '--port', 'abc'])).toContain('--port');
    expect(plan(['preview', '--port', '70000'])).toContain('--port');
  });
});

describe('loadRenderer', () => {
  it('is the module default export', async () => {
    expect(await loadRenderer(RENDERER)).toBeInstanceOf(BodyRenderer);
  });

  // A consumer writes `--renderer ./my-renderer.ts` meaning their cwd, and
  // `import()` alone would look inside node_modules/@dunx/infra/dist.
  it('resolves a relative specifier against the cwd', async () => {
    const relative = `./${relativePath(process.cwd(), RENDERER)}`;

    expect(await loadRenderer(relative)).toBeInstanceOf(BodyRenderer);
  });

  it('refuses a module that exports something else', async () => {
    const dir = await TemplateDir.create();
    const file = await dir.write('nope.ts', 'export default 1;\n');

    await expect(loadRenderer(file)).rejects.toThrow(
      /must default-export a TemplateRenderer/,
    );
    await dir.remove();
  });
});

describe('main', () => {
  let logged: string[];
  let errored: string[];

  beforeEach(() => {
    logged = [];
    errored = [];
    spyOn(console, 'log').mockImplementation((...a: unknown[]) => {
      logged.push(a.map(String).join(' '));
    });
    spyOn(console, 'error').mockImplementation((...a: unknown[]) => {
      errored.push(a.map(String).join(' '));
    });
  });

  afterEach(() => {
    spyOn(console, 'log').mockRestore();
    spyOn(console, 'error').mockRestore();
  });

  it('prints the usage and succeeds for --help', async () => {
    expect(await main(['--help'])).toEqual({ code: 0 });
    expect(logged.join('')).toContain('dunx-email preview');
  });

  it('fails and writes to stderr for a bad argument', async () => {
    expect(await main(['send'])).toEqual({ code: 1 });
    expect(errored.join('')).toContain('Unknown command');
  });

  it('exports every template and names each file', async () => {
    const dir = await TemplateDir.create();
    const out = await TemplateDir.create();
    await dir.template('welcome.ts', 'W');

    const { code, server } = await main([
      'export',
      dir.path,
      '--out',
      out.path,
      '--renderer',
      RENDERER,
    ]);

    expect(code).toBe(0);
    expect(server).toBeUndefined();
    expect(logged.join('')).toContain('welcome.html');
    expect(await Bun.file(`${out.path}/welcome.html`).text()).toBe('<p>W!</p>');
    await dir.remove();
    await out.remove();
  });

  // Found by running the built CLI: a directory that does not exist used to
  // print a bare ENOENT stack and a renderer that does not resolve threw.
  it('answers a missing directory with the message, not a stack', async () => {
    const { code, server } = await main([
      'export',
      '/nowhere/at/all',
      '--renderer',
      RENDERER,
    ]);

    expect(code).toBe(1);
    expect(server).toBeUndefined();
    expect(errored.join('')).toContain('No templates directory at');
  });

  it('answers a renderer that does not resolve the same way', async () => {
    const dir = await TemplateDir.create();

    const { code } = await main([
      'export',
      dir.path,
      '--renderer',
      './nope.ts',
    ]);

    expect(code).toBe(1);
    expect(errored.join('')).toContain('nope.ts');
    await dir.remove();
  });

  it('serves the preview and says where', async () => {
    const dir = await TemplateDir.create();
    await dir.template('welcome.ts', 'W');

    const { code, server } = await main([
      'preview',
      dir.path,
      '--port',
      '0',
      '--renderer',
      RENDERER,
    ]);

    expect(code).toBe(0);
    expect(logged.join('')).toContain('Email preview on');
    // `main` hands back the server precisely because it does not exit: the
    // shell leaves it running, and a suite has to stop it.
    expect(server).toBeDefined();
    expect((await fetch(server?.url ?? '')).status).toBe(200);
    await server?.stop(true);
    await dir.remove();
  });
});
