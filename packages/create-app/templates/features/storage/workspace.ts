import { Logger } from '@dunx/core';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { OnShutdown } from '@dunx/core';

/**
 * Owns a scratch directory under the OS temp dir - never inside the repo - and
 * removes it on shutdown, so two consecutive `bun start` runs cannot see each
 * other's bytes.
 *
 * The storage factory injects this, so it is constructed *before* `Storage`, and
 * reverse-order shutdown therefore removes the directory after everything that
 * writes into it has drained.
 */
export class Workspace implements OnShutdown {
  #root: string | undefined;

  constructor(private readonly logger: Logger) {}

  /** `mkdtemp`, so a concurrent run gets its own directory rather than sharing. */
  async create(): Promise<string> {
    this.#root ??= await mkdtemp(join(tmpdir(), 'dunx-full-'));
    return this.#root;
  }

  async onShutdown(): Promise<void> {
    if (this.#root === undefined) return;
    await rm(this.#root, { recursive: true, force: true });
    this.logger.info(`workspace removed: ${this.#root}`);
    this.#root = undefined;
  }
}
