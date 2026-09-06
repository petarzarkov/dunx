import { Logger } from '@dunx/core';
import type { OnInit } from '@dunx/core';

/**
 * The list is capped, and the cap is the point.
 *
 * An in-memory demo store that only ever grows is a leak the moment anyone runs
 * real traffic through it, and this folder is vendored into `@dunx/create-app`'s
 * `notes` feature, so an unbounded array would ship into every scaffold. The soak
 * run found it: 42,000 posts a minute put 250,000 retained strings on the heap and
 * read as a framework leak until the census named them.
 */
const KEEP = 200;

export class NotesService implements OnInit {
  readonly #rows = ['read the architecture doc', 'measure before deciding'];

  constructor(private readonly logger: Logger) {}

  onInit(): void {
    this.logger.info('notes ready');
  }

  rows(): readonly string[] {
    return this.#rows;
  }

  add(text: string): readonly string[] {
    this.#rows.push(text);
    if (this.#rows.length > KEEP) {
      this.#rows.splice(0, this.#rows.length - KEEP);
    }
    return this.#rows;
  }
}
