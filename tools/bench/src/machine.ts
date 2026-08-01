import { arch, cpus, platform, release, totalmem } from 'node:os';
import type { MachineInfo, Subject, SubjectInfo } from './types.js';
import { repoRoot, root } from './paths.js';

const nodeVersion = async (nodeBinary: string): Promise<string> => {
  try {
    const proc = Bun.spawn([nodeBinary, '--version'], {
      stdout: 'pipe',
      stderr: 'ignore',
    });
    const text = (await new Response(proc.stdout).text()).trim();
    await proc.exited;
    return text === '' ? 'not found' : text;
  } catch {
    return 'not found';
  }
};

export const readMachine = async (
  nodeBinary: string,
): Promise<MachineInfo> => ({
  cpuModel: cpus()[0]?.model.replace(/\s+/g, ' ').trim() ?? 'unknown',
  cores: cpus().length,
  ramGiB: Math.round((totalmem() / 1024 ** 3) * 10) / 10,
  platform: platform(),
  kernel: release(),
  arch: arch(),
  bun: Bun.version,
  node: await nodeVersion(nodeBinary),
});

const packageVersion = async (name: string): Promise<string> => {
  for (const base of [root, repoRoot]) {
    const manifest = Bun.file(`${base}/node_modules/${name}/package.json`);
    if (await manifest.exists()) {
      const parsed = (await manifest.json()) as { version?: string };
      return parsed.version ?? 'unknown';
    }
  }
  return 'unknown';
};

export const describeSubjects = async (
  list: readonly Subject[],
): Promise<readonly SubjectInfo[]> =>
  Promise.all(
    list.map(async (subject) => ({
      ...subject,
      version:
        subject.versionOf === null
          ? 'n/a'
          : await packageVersion(subject.versionOf),
    })),
  );
