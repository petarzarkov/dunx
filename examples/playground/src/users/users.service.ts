import type { OnInit, OnShutdown } from '@dunx/core';
import { Config } from '../config.js';
import { Logger } from '../logger.js';
import { UsersRepository } from './users.repository.js';

export class UsersService implements OnInit, OnShutdown {
  constructor(
    private readonly repository: UsersRepository,
    private readonly logger: Logger,
    private readonly config: Config,
  ) {}

  onInit(): void {
    this.logger.info(`${this.config.appName}: users ready`);
  }

  onShutdown(): void {
    this.logger.info('users draining');
  }

  rows(): readonly string[] {
    return this.repository.findAll();
  }

  summary(): string {
    return this.repository.findAll().join(' | ');
  }
}
