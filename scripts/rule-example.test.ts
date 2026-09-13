import { describe, expect, it } from 'bun:test';
import { Glob } from 'bun';
import { publishedWorkspaces, specifiersIn, subpathsOf } from './published.js';
import { ROOT } from './workspace-ranges.js';

/**
 * Rule 4, as a gate. A capability with no example has no test that its public
 * shape is usable: `ThrottleModule`, `ScheduleModule`, `StaticModule` and the
 * whole `@dunx/http/client` subpath all shipped without one and it went
 * unnoticed for weeks. All four worked; nothing proved it.
 */
const EXAMPLE = 'examples/full';

/**
 * Subpaths no example can import, each for a reason that is not "nobody wrote
 * one yet".
 */
const UNREACHABLE: Readonly<Record<string, string>> = Object.freeze({
  '@dunx/dashboard/ui': 'the React bundle DashboardMiddleware await-imports',
  '@dunx/http/internal': 'the cross-package surface @dunx/auth builds on',
  '@dunx/create-app': 'a CLI, covered by check:scaffolds',
  '@dunx/mcp': 'a CLI, run rather than imported',
  '@dunx/mcp/cli': 'a CLI, run rather than imported',
  '@dunx/infra':
    'a barrel over the subpaths, which its own header calls the better import',
  '@dunx/transform':
    'the plugin authoring API; the consumer line is the /preload subpath',
});

const reachedByExample = async (): Promise<Set<string>> => {
  const base = `${ROOT}${EXAMPLE}`;
  const reached = new Set<string>();

  for await (const rel of new Glob('**/*.ts').scan({ cwd: base })) {
    if (rel.startsWith('node_modules/')) continue;
    const source = await Bun.file(`${base}/${rel}`).text();
    for (const spec of specifiersIn(source)) reached.add(spec);
  }

  // `@dunx/transform/preload` is named in bunfig.toml rather than imported, and
  // it is the line every consumer has to write, so it counts as exercised.
  const bunfig = Bun.file(`${base}/bunfig.toml`);
  if (await bunfig.exists()) {
    const text = (await bunfig.text()).replace(/^\s*#.*$/gm, '');
    for (const match of text.matchAll(/"([^"]+)"/g)) {
      const spec = match[1];
      if (spec?.startsWith('@dunx/')) reached.add(spec);
    }
  }
  return reached;
};

describe('Rule 4 - a feature is not shipped until an example uses it', () => {
  it('every public subpath is exercised by examples/full', async () => {
    const reached = await reachedByExample();
    const missing: string[] = [];
    for (const ws of await publishedWorkspaces()) {
      for (const subpath of subpathsOf(ws)) {
        if (reached.has(subpath)) continue;
        if (subpath in UNREACHABLE) continue;
        missing.push(subpath);
      }
    }
    expect(missing).toEqual([]);
  });

  it('every exemption still names a real subpath', async () => {
    const declared = new Set<string>();
    for (const ws of await publishedWorkspaces()) {
      for (const subpath of subpathsOf(ws)) declared.add(subpath);
    }
    const stale = Object.keys(UNREACHABLE).filter((s) => !declared.has(s));
    expect(stale).toEqual([]);
  });
});
