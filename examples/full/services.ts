/**
 * `compose pull` across registries, then `compose up --wait`.
 *
 * Anonymous pulls are rate limited per IP and a CI runner shares its IP with
 * every other runner on the host, so the pull is the one step here that fails
 * for reasons that have nothing to do with the change under test. Retrying one
 * registry was not enough: it broke two runs inside an hour.
 *
 * So a round tries each registry in turn, and a round that fails everywhere
 * backs off and starts again. `up --wait` afterwards is offline once the images
 * are local, and it is the part that must not be retried blindly: a container
 * that fails its healthcheck is a real failure.
 */

/** Each image as Docker Hub spells it in full, including the `library/`
 * namespace an official image lets a `docker pull` leave out. */
const IMAGES = Object.freeze({
  DUNX_VALKEY_IMAGE: 'valkey/valkey:8-alpine',
  DUNX_POSTGRES_IMAGE: 'library/postgres:17-alpine',
  DUNX_RABBITMQ_IMAGE: 'library/rabbitmq:4-alpine',
});

interface Registry {
  readonly name: string;
  /** This registry's spelling of a Docker Hub path. */
  readonly ref: (path: string) => string;
}

/**
 * Tried in order, and adding a fourth is one entry: nothing else here names a
 * registry, and `compose.yml` serves whatever this sets.
 *
 * Measured 2026-09-13: Hub and mirror.gcr.io served all three, public.ecr.aws
 * answered `toomanyrequests` for two of them.
 */
const REGISTRIES: readonly Registry[] = [
  { name: 'docker.io', ref: (path) => `docker.io/${path}` },
  {
    name: 'public.ecr.aws',
    // Hub's official images sit under `docker/library` here, and everything
    // else under the publisher's own namespace.
    ref: (path) =>
      path.startsWith('library/')
        ? `public.ecr.aws/docker/${path}`
        : `public.ecr.aws/${path}`,
  },
  // A pull-through cache of Hub, so a Hub path resolves here unchanged.
  { name: 'mirror.gcr.io', ref: (path) => `mirror.gcr.io/${path}` },
];

const ROUNDS = 3;

const imagesFrom = (registry: Registry): Record<string, string> =>
  Object.fromEntries(
    Object.entries(IMAGES).map(([key, path]) => [key, registry.ref(path)]),
  );

const run = async (
  args: readonly string[],
  images?: Record<string, string>,
): Promise<number> => {
  const proc = Bun.spawn(['docker', 'compose', ...args], {
    cwd: import.meta.dir,
    ...(images === undefined ? {} : { env: { ...process.env, ...images } }),
    stdout: 'inherit',
    stderr: 'inherit',
  });
  return proc.exited;
};

/** Answers with the registry that served, so `up` starts what `pull` fetched
 * rather than resolving `compose.yml`'s defaults and pulling again. */
const pull = async (): Promise<Registry> => {
  for (let round = 1; round <= ROUNDS; round += 1) {
    for (const registry of REGISTRIES) {
      if ((await run(['pull', '--quiet'], imagesFrom(registry))) === 0) {
        return registry;
      }
      console.log(`pull from ${registry.name} failed`);
    }
    if (round === ROUNDS) break;
    // 2s then 4s, and the registries come before the sleep: another provider is
    // a faster retry than waiting out one provider's throttle window.
    const waitMs = 2000 * 2 ** (round - 1);
    console.log(
      `every registry failed, round ${round}/${ROUNDS}; retrying in ${waitMs / 1000}s`,
    );
    await Bun.sleep(waitMs);
  }
  throw new Error(
    `docker compose pull failed ${ROUNDS} times from each of ` +
      `${REGISTRIES.map((registry) => registry.name).join(', ')}. The last one ` +
      'is above; a rate limit is the usual reason and it clears on its own.',
  );
};

const served = await pull();
console.log(`images from ${served.name}`);
process.exit(await run(['up', '-d', '--wait'], imagesFrom(served)));
