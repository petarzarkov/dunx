import { Logger } from '@dunx/core';
import type { OnInit } from '@dunx/core';

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
    return this.#rows;
  }
}
