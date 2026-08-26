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

const escape = (value: string): string =>
  value.replaceAll(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * The compiled subjects have no `node_modules`, so their framework version comes
 * out of the manifest that pins it. Reading the file rather than hardcoding the
 * number is what stops the report disagreeing with what was actually built.
 */
const manifestVersion = async (
  subject: Subject,
  name: string,
): Promise<string> => {
  const patterns: Partial<Record<string, [string, RegExp]>> = {
    go: [`${root}/servers/go/go.mod`, new RegExp(`${escape(name)}\\s+(v\\S+)`)],
    rust: [
      `${root}/servers/rust/Cargo.lock`,
      new RegExp(`name = "${escape(name)}"\\nversion = "([^"]+)"`),
    ],
    jvm: [
      `${root}/servers/java/pom.xml`,
      new RegExp(
        `<artifactId>${escape(name)}</artifactId>\\s*<version>([^<]+)</version>`,
      ),
    ],
    // ASP.NET Core ships in the shared framework rather than as a package, so
    // there is no version to read: what pins it is the target framework, and
    // `versionOf: 'TargetFramework'` names the property that holds it.
    dotnet: [
      `${root}/servers/dotnet/Directory.Build.props`,
      new RegExp(`<${escape(name)}>([^<]+)</`),
    ],
  };
  const found = patterns[subject.runtime];
  if (found === undefined) return packageVersion(name);
  const [path, pattern] = found;
  const file = Bun.file(path);
  if (!(await file.exists())) return 'unknown';
  return pattern.exec(await file.text())?.[1] ?? 'unknown';
};

export const describeSubjects = async (
  list: readonly Subject[],
  /** Python package versions from `probePython`, which reads the interpreter. */
  pythonVersions?: ReadonlyMap<string, string | null>,
): Promise<readonly SubjectInfo[]> =>
  Promise.all(
    list.map(async (subject) => ({
      ...subject,
      version: await subjectVersion(subject, pythonVersions),
    })),
  );

const subjectVersion = async (
  subject: Subject,
  pythonVersions?: ReadonlyMap<string, string | null>,
): Promise<string> => {
  if (subject.versionOf === null) return 'n/a';
  if (subject.runtime === 'python') {
    return pythonVersions?.get(subject.versionOf) ?? 'unknown';
  }
  return manifestVersion(subject, subject.versionOf);
};
