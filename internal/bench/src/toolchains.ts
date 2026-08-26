/**
 * The compiled subjects - Go, Rust, the JVM and .NET - and the two rules that
 * keep them honest.
 *
 * **They are opt-in.** `internal/bench` needs only Bun to run, and CI has no Go,
 * Rust, JDK or .NET SDK. Each toolchain is probed once; if it is missing the harness says
 * so, drops those subjects and still exits 0, exactly the way the Node subjects
 * are dropped when `node` does not resolve. Nothing is downloaded or installed.
 *
 * **Compilation is not startup.** Every artifact is produced here, before any
 * measurement, so `buildSeconds` lands in the report next to the toolchain and
 * never inside the startup column. What the startup column then times is the
 * same thing for everyone: a cold process answering its first request.
 */
import { dirname, relative } from 'node:path';
import { binDir, buildDir, root } from './paths.js';
import type { Runtime, Subject, ToolchainInfo } from './types.js';

export const NATIVE_RUNTIMES = Object.freeze([
  'go',
  'rust',
  'jvm',
  'dotnet',
] as const);
export type NativeRuntime = (typeof NATIVE_RUNTIMES)[number];

export const isNativeRuntime = (runtime: Runtime): runtime is NativeRuntime =>
  (NATIVE_RUNTIMES as readonly string[]).includes(runtime);

interface Tool {
  /** Environment override, the same idea as `BENCH_NODE`. */
  readonly env: string;
  readonly fallback: string;
  readonly versionArgs: readonly string[];
}

interface Toolchain {
  readonly runtime: NativeRuntime;
  readonly label: string;
  readonly hint: string;
  readonly tools: readonly Tool[];
  /** Extra environment both the probe and the build need, derived from the binaries. */
  readonly envFor: (binaries: readonly string[]) => Record<string, string>;
  /** Compiles the subject and returns the argv that runs the artifact. */
  readonly compile: (
    subject: Subject,
    binaries: readonly string[],
  ) => Promise<readonly string[]>;
}

export interface ToolchainStatus {
  readonly runtime: NativeRuntime;
  readonly label: string;
  /** `null` when one of the required binaries did not resolve. */
  readonly version: string | null;
  readonly binaries: readonly string[];
  readonly hint: string;
}

interface Captured {
  readonly ok: boolean;
  readonly text: string;
}

const capture = async (
  argv: readonly string[],
  cwd: string | undefined,
  env: Readonly<Record<string, string>>,
): Promise<Captured> => {
  try {
    const proc = Bun.spawn([...argv], {
      ...(cwd === undefined ? {} : { cwd }),
      env: { ...process.env, ...env },
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const [out, err] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    return { ok: (await proc.exited) === 0, text: `${out}${err}` };
  } catch (cause) {
    return {
      ok: false,
      text: cause instanceof Error ? cause.message : String(cause),
    };
  }
};

const build = async (
  subject: Subject,
  argv: readonly string[],
  cwd: string,
  env: Readonly<Record<string, string>>,
): Promise<void> => {
  const result = await capture(argv, cwd, env);
  if (!result.ok) {
    throw new Error(
      `Building ${subject.id} failed.\n  ${argv.join(' ')}\n  (in ${cwd})\n${result.text}`,
    );
  }
};

/** `/opt/jdk/bin/java` -> `/opt/jdk`, which is what Maven wants in JAVA_HOME. */
const javaHome = (java: string): Record<string, string> =>
  java.includes('/') ? { JAVA_HOME: dirname(dirname(java)) } : {};

const noEnv = (): Record<string, string> => ({});

/**
 * Keeps the SDK's caches inside the workspace, the way `.bin/m2` does for Maven:
 * `dotnet` otherwise writes NuGet packages and a first-run sentinel into the home
 * directory.
 */
const dotnetEnv = (): Record<string, string> => ({
  NUGET_PACKAGES: `${binDir}/nuget`,
  DOTNET_CLI_HOME: `${binDir}/dotnet-home`,
  DOTNET_CLI_TELEMETRY_OPTOUT: '1',
  DOTNET_NOLOGO: '1',
});

const TOOLCHAINS: readonly Toolchain[] = [
  {
    runtime: 'go',
    label: 'Go',
    hint: 'Install Go from https://go.dev/dl, or set BENCH_GO to a go binary.',
    tools: [{ env: 'BENCH_GO', fallback: 'go', versionArgs: ['version'] }],
    envFor: noEnv,
    compile: async (subject, binaries) => {
      const go = binaries[0] ?? 'go';
      const moduleDir = `${root}/servers/go`;
      const pkg = relative(moduleDir, `${root}/${dirname(subject.entry)}`);
      const out = `${buildDir}/${subject.id}`;
      await build(subject, [go, 'build', '-o', out, `./${pkg}`], moduleDir, {});
      return [out];
    },
  },
  {
    runtime: 'rust',
    label: 'Rust',
    hint: 'Install Rust from https://rustup.rs, or set BENCH_CARGO to a cargo binary.',
    tools: [
      { env: 'BENCH_CARGO', fallback: 'cargo', versionArgs: ['--version'] },
    ],
    envFor: noEnv,
    compile: async (subject, binaries) => {
      const cargo = binaries[0] ?? 'cargo';
      const target = `${buildDir}/rust`;
      // A plain `--release`, with no profile overrides: LTO and
      // codegen-units=1 are tuning nothing else in this suite gets.
      await build(
        subject,
        [cargo, 'build', '--release', '--bin', subject.id],
        `${root}/servers/rust`,
        { CARGO_TARGET_DIR: target },
      );
      return [`${target}/release/${subject.id}`];
    },
  },
  {
    runtime: 'jvm',
    label: 'JDK + Maven',
    hint: 'Install a JDK 21+ and Maven, or set BENCH_JAVA and BENCH_MVN.',
    tools: [
      { env: 'BENCH_JAVA', fallback: 'java', versionArgs: ['-version'] },
      { env: 'BENCH_MVN', fallback: 'mvn', versionArgs: ['-version'] },
    ],
    envFor: (binaries) => javaHome(binaries[0] ?? 'java'),
    compile: async (subject, binaries) => {
      const java = binaries[0] ?? 'java';
      const mvn = binaries[1] ?? 'mvn';
      const target = `${buildDir}/java`;
      // The local repository is inside .bin/ rather than ~/.m2 so a benchmark
      // run leaves nothing behind outside the workspace.
      await build(
        subject,
        [
          mvn,
          '-B',
          '-q',
          '-DskipTests',
          `-Dmaven.repo.local=${binDir}/m2`,
          `-Dbench.target=${target}`,
          'package',
        ],
        `${root}/servers/java`,
        javaHome(java),
      );
      // `finalName` in pom.xml is the subject id, so this is the fat jar.
      return [java, '-jar', `${target}/${subject.id}.jar`];
    },
  },
  {
    runtime: 'dotnet',
    label: '.NET SDK',
    hint: 'Install the .NET 10 SDK from https://dotnet.microsoft.com/download, or set BENCH_DOTNET to a dotnet binary.',
    tools: [
      { env: 'BENCH_DOTNET', fallback: 'dotnet', versionArgs: ['--version'] },
    ],
    envFor: dotnetEnv,
    compile: async (subject, binaries) => {
      const dotnet = binaries[0] ?? 'dotnet';
      const target = `${buildDir}/dotnet`;
      const out = `${target}/${subject.id}`;
      // A plain `publish -c Release`: no ReadyToRun, no Native AOT, no trimming
      // and no invariant globalization, none of which anything else here gets.
      //
      // `BenchTarget` goes through the environment rather than as
      // `-p:BenchTarget=`, which the 10.0.400 CLI forwards to MSBuild stripped of
      // its `--property:` prefix; MSBuild then reads it as a second project file
      // and fails with MSB1008. MSBuild reads environment variables as
      // properties, and Directory.Build.props points obj/ and bin/ at it.
      await build(
        subject,
        [
          dotnet,
          'publish',
          `${root}/${dirname(subject.entry)}`,
          '-c',
          'Release',
          '--nologo',
          '-o',
          out,
        ],
        `${root}/servers/dotnet`,
        { ...dotnetEnv(), BenchTarget: target },
      );
      // `dotnet <dll>`, the way the JVM subject is `java -jar`: UseAppHost is off
      // in Directory.Build.props, so there is no native launcher to hunt for a
      // shared framework the SDK never registered with the machine.
      return [dotnet, `${out}/${subject.id}.dll`];
    },
  },
];

const toolchainFor = (runtime: NativeRuntime): Toolchain => {
  const found = TOOLCHAINS.find((chain) => chain.runtime === runtime);
  if (found === undefined) throw new Error(`No toolchain for ${runtime}`);
  return found;
};

export const probeToolchain = async (
  runtime: NativeRuntime,
): Promise<ToolchainStatus> => {
  const chain = toolchainFor(runtime);
  const binaries = chain.tools.map(
    (tool) => process.env[tool.env] ?? tool.fallback,
  );
  const env = chain.envFor(binaries);
  const base = {
    runtime,
    label: chain.label,
    binaries,
    hint: chain.hint,
  };

  const versions: string[] = [];
  for (const [index, tool] of chain.tools.entries()) {
    const binary = binaries[index] ?? tool.fallback;
    const probe = await capture([binary, ...tool.versionArgs], undefined, env);
    if (!probe.ok) return { ...base, version: null };
    versions.push(probe.text.trim().split('\n')[0]?.trim() ?? binary);
  }
  return { ...base, version: versions.join(' + ') };
};

export interface Compiled {
  readonly exec: readonly string[];
  readonly seconds: number;
}

export const compileSubject = async (
  subject: Subject,
  status: ToolchainStatus,
): Promise<Compiled> => {
  const started = performance.now();
  const exec = await toolchainFor(status.runtime).compile(
    subject,
    status.binaries,
  );
  return { exec, seconds: (performance.now() - started) / 1000 };
};

export const toolchainInfo = (
  status: ToolchainStatus,
  subjects: readonly string[],
  seconds: number,
): ToolchainInfo => ({
  runtime: status.runtime,
  label: status.label,
  version: status.version,
  subjects,
  buildSeconds: Math.round(seconds * 10) / 10,
});

/**
 * Python, probed the way Node is rather than compiled the way Go is: it is an
 * interpreter, so there is no artifact and no build time to keep out of the
 * startup column.
 *
 * Each package has to be importable, not merely present on disk - a Python that
 * cannot `import django` would start, fail its first request and be dropped by
 * the equivalence check with a confusing message instead of a clear skip.
 *
 * **Probed per package, not once.** There are two Python subjects and their
 * dependencies are disjoint, so a machine with Django and no FastAPI has to run
 * one and skip the other. A single answer for "is Python usable" would take both
 * down together.
 *
 * `BENCH_PYTHONPATH` exists because neither is commonly installed system-wide;
 * point it at a directory holding extracted wheels and nothing has to be
 * installed at all.
 */
export interface PythonProbe {
  readonly binary: string;
  /** Version per package name, `null` when it cannot be imported. */
  readonly versions: ReadonlyMap<string, string | null>;
  readonly env: Record<string, string>;
}

export const probePython = async (
  packages: readonly string[],
): Promise<PythonProbe> => {
  const binary = process.env['BENCH_PYTHON'] ?? 'python3';
  const extra = process.env['BENCH_PYTHONPATH'];
  const env = extra === undefined ? {} : { PYTHONPATH: extra };

  const versions = new Map<string, string | null>();
  await Promise.all(
    [...new Set(packages)].map(async (name) => {
      // `importlib.metadata` rather than a per-package attribute: django has
      // `get_version()`, fastapi has `__version__`, and the distribution
      // metadata is the one thing both have. The import is still what decides
      // usability, so it runs first and its failure is the skip.
      const probed = await capture(
        [
          binary,
          '-c',
          `import ${name}, importlib.metadata as m; print(m.version(${JSON.stringify(name)}))`,
        ],
        undefined,
        env,
      );
      versions.set(
        name,
        probed.ok ? (probed.text.trim().split('\n').at(-1) ?? null) : null,
      );
    }),
  );

  return { binary, versions, env };
};
