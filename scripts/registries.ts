/**
 * Pulling a container image from the first registry that answers.
 *
 * Every public registry rate limits anonymous pulls by IP, and a CI runner
 * shares its IP with every other runner on the host, so any single registry is a
 * coin toss that fails as a red build with nothing wrong in the change. It broke
 * the examples job twice in an hour, and the second one skipped the release job
 * behind it.
 *
 * Retrying one registry cannot fix that: the exhausted budget is that
 * registry's, so the retry asks the same throttle again. Another provider is the
 * faster retry, which is why a round tries them all before anything sleeps.
 *
 * Here rather than beside a compose file so a second caller shares the list
 * rather than writing a fourth spelling of `public.ecr.aws/docker/library`.
 */

/** One registry, and how it spells a Docker Hub repository path. */
export interface Registry {
  readonly name: string;
  /**
   * `ref('library/postgres:17-alpine')` for this registry. The argument is the
   * Hub path in full, including the `library/` namespace an official image lets
   * a `docker pull` leave out.
   */
  readonly ref: (path: string) => string;
}

/** Hub's own namespace for an official image. `postgres` is `library/postgres`. */
const OFFICIAL = 'library/';

/**
 * Tried in order. Adding a provider is one entry, and nothing outside this file
 * names a registry.
 *
 * Measured 2026-09-13, during an ECR outage: Docker Hub and mirror.gcr.io served
 * valkey, postgres and rabbitmq, and public.ecr.aws answered `toomanyrequests`
 * for two of the three.
 */
export const REGISTRIES: readonly Registry[] = [
  { name: 'docker.io', ref: (path) => `docker.io/${path}` },
  {
    name: 'public.ecr.aws',
    // Hub's official images are mirrored under `docker/library` here, and
    // everything else under the publisher's own namespace.
    ref: (path) =>
      path.startsWith(OFFICIAL)
        ? `public.ecr.aws/docker/${path}`
        : `public.ecr.aws/${path}`,
  },
  // A pull-through cache of Hub, so a Hub path resolves here unchanged.
  { name: 'mirror.gcr.io', ref: (path) => `mirror.gcr.io/${path}` },
];

/** Rounds of the whole list before giving up. */
const ROUNDS = 3;

/** First backoff, doubled each round. A throttle window is seconds, not minutes. */
const FIRST_BACKOFF_MS = 2_000;

export interface FallbackOptions {
  /** Defaults to {@link REGISTRIES}. */
  readonly registries?: readonly Registry[];
  /** Passes over the whole list before giving up. Defaults to 3. */
  readonly rounds?: number;
  readonly log?: (message: string) => void;
  /** Injectable so a test does not wait out the backoff. */
  readonly sleep?: (ms: number) => Promise<void>;
}

/**
 * Maps each variable to this registry's spelling of the path it holds, ready to
 * hand a child process as environment.
 */
export const imageRefs = (
  registry: Registry,
  images: Readonly<Record<string, string>>,
): Record<string, string> =>
  Object.fromEntries(
    Object.entries(images).map(([variable, path]) => [
      variable,
      registry.ref(path),
    ]),
  );

/**
 * Runs `attempt` against each registry in turn until one answers true, and
 * answers with the registry that did, so the caller can use the same images for
 * whatever comes after the pull.
 *
 * Sleeps only once a whole round has failed. Throws when every round has.
 */
export const fromFirstRegistry = async (
  attempt: (registry: Registry) => Promise<boolean>,
  options: FallbackOptions = {},
): Promise<Registry> => {
  const {
    registries = REGISTRIES,
    rounds = ROUNDS,
    log = console.log,
    sleep = Bun.sleep,
  } = options;

  for (let round = 1; round <= rounds; round += 1) {
    for (const registry of registries) {
      if (await attempt(registry)) return registry;
      log(`${registry.name} did not serve`);
    }
    if (round === rounds) break;
    const waitMs = FIRST_BACKOFF_MS * 2 ** (round - 1);
    log(
      `no registry served, round ${round}/${rounds}; retrying in ${waitMs / 1000}s`,
    );
    await sleep(waitMs);
  }

  throw new Error(
    `No registry served after ${rounds} round(s) of ` +
      `${registries.map((registry) => registry.name).join(', ')}. The last ` +
      'failure is above; a rate limit is the usual reason and it clears on ' +
      'its own.',
  );
};
