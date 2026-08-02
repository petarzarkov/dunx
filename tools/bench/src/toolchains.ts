/**
 * The compiled subjects - Go, Rust and the JVM - and the two rules that keep
 * them honest.
 *
 * **They are opt-in.** `tools/bench` needs only Bun to run, and CI has no Go,
 * Rust or JDK. Each toolchain is probed once; if it is missing the harness says
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

export const NATIVE_RUNTIMES = Object.freeze(['go', 'rust', 'jvm'] as const);
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
 * Django has to be importable, not merely present on disk - a Python that cannot
 * `import django` would start, fail its first request and be dropped by the
 * equivalence check with a confusing message instead of a clear skip.
 *
 * `BENCH_PYTHONPATH` exists because Django is commonly not installed
 * system-wide; point it at a directory holding an extracted wheel and nothing
 * has to be installed at all.
 */
export const probePython = async (): Promise<{
  binary: string;
  version: string | null;
  env: Record<string, string>;
}> => {
  const binary = process.env['BENCH_PYTHON'] ?? 'python3';
  const extra = process.env['BENCH_PYTHONPATH'];
  const env = extra === undefined ? {} : { PYTHONPATH: extra };

  const probed = await capture(
    [binary, '-c', 'import django; print(django.get_version())'],
    undefined,
    env,
  );

  return {
    binary,
    version: probed.ok ? (probed.text.trim().split('\n')[0] ?? null) : null,
    env,
  };
};
