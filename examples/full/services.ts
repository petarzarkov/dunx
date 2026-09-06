/**
 * `compose pull` with retries, then `compose up --wait`.
 *
 * A registry throttles anonymous pulls and a CI runner shares its IP with every
 * other runner on the host, so the pull is the one step here that fails for
 * reasons that have nothing to do with the change under test. Moving off Docker
 * Hub to public.ecr.aws bought a much larger budget and not an unlimited one:
 * `toomanyrequests: Rate exceeded` turned up on main the first time this ran, and
 * three pulls in a row hit it locally while the file was being written.
 *
 * So the pull is separated from the start and retried. `up --wait` afterwards is
 * offline once the images are local, and it is the part that must not be retried
 * blindly: a container that fails its healthcheck is a real failure.
 */
const ATTEMPTS = 5;

const run = async (args: readonly string[]): Promise<number> => {
  const proc = Bun.spawn(['docker', 'compose', ...args], {
    cwd: import.meta.dir,
    stdout: 'inherit',
    stderr: 'inherit',
  });
  return proc.exited;
};

const pull = async (): Promise<void> => {
  for (let attempt = 1; attempt <= ATTEMPTS; attempt += 1) {
    if ((await run(['pull', '--quiet'])) === 0) return;
    if (attempt === ATTEMPTS) {
      throw new Error(
        `docker compose pull failed ${ATTEMPTS} times. The last one is above; a ` +
          'rate limit is the usual reason and it clears on its own.',
      );
    }
    // 2s, 4s, 8s, 16s. A throttle window is seconds, not minutes.
    const waitMs = 2000 * 2 ** (attempt - 1);
    console.log(
      `pull failed, retrying in ${waitMs / 1000}s (${attempt}/${ATTEMPTS - 1})`,
    );
    await Bun.sleep(waitMs);
  }
};

await pull();
const code = await run(['up', '-d', '--wait']);
process.exit(code);
