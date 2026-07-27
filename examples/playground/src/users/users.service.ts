import { inject, type OnInit, type OnShutdown } from '@dunx/core';
import { Config } from '../config.js';
import { Logger } from '../logger.js';
import { UsersRepository } from './users.repository.js';

export class UsersService implements OnInit, OnShutdown {
  readonly #repository = inject(UsersRepository);
  readonly #logger = inject(Logger);
  readonly #config = inject(Config);

  onInit(): void {
    this.#logger.info(`${this.#config.appName}: users ready`);
  }

  onShutdown(): void {
    this.#logger.info('users draining');
  }

  summary(): string {
    return this.#repository.findAll().join(' | ');
  }
}
