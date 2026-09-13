/**
 * `compose pull` across registries, then `compose up --wait`.
 *
 * The registry list and the fallback are `scripts/registries.ts`, so a second
 * compose file shares them rather than writing its own. What is here is what is
 * this example's: which images it needs, and the compose call.
 *
 * `up --wait` is offline once the images are local, and it is the part that must
 * not be retried blindly: a container that fails its healthcheck is a real
 * failure. It gets the registry that served, or compose would resolve the
 * defaults in `compose.yml` and pull a second time.
 */
import {
  fromFirstRegistry,
  imageRefs,
  type Registry,
} from '../../scripts/registries.js';

/** Each image as Docker Hub spells it in full, keyed by the variable
 * `compose.yml` reads it from. */
const IMAGES = Object.freeze({
  DUNX_VALKEY_IMAGE: 'valkey/valkey:8-alpine',
  DUNX_POSTGRES_IMAGE: 'library/postgres:17-alpine',
  DUNX_RABBITMQ_IMAGE: 'library/rabbitmq:4-alpine',
});

const compose = async (
  args: readonly string[],
  registry: Registry,
): Promise<number> => {
  const proc = Bun.spawn(['docker', 'compose', ...args], {
    cwd: import.meta.dir,
    env: { ...process.env, ...imageRefs(registry, IMAGES) },
    stdout: 'inherit',
    stderr: 'inherit',
  });
  return proc.exited;
};

const served = await fromFirstRegistry(
  async (registry) => (await compose(['pull', '--quiet'], registry)) === 0,
);
console.log(`images from ${served.name}`);
process.exit(await compose(['up', '-d', '--wait'], served));
