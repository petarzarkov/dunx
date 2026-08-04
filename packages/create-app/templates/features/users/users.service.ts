import { Logger } from '@dunx/core';
import type { OnInit, OnShutdown } from '@dunx/core';
import { AppConfigService } from '../config.js';
import { UsersRepository, type User } from './users.repository.js';

export class UsersService implements OnInit, OnShutdown {
  // `ConfigService<AppConfig>` injects because the transform records the bare
  // name of a generic annotation - the type argument costs nothing at runtime.
  constructor(
    private readonly repository: UsersRepository,
    private readonly logger: Logger,
    private readonly config: AppConfigService,
  ) {}

  /** `onInit` is awaited, so the schema exists before the first request arrives. */
  async onInit(): Promise<void> {
    await this.repository.migrate();
    await this.repository.seed(this.config.get('seedUsers'));
    this.logger.info(`${this.config.get('appName')}: users ready`);
  }

  onShutdown(): void {
    this.logger.info('users draining');
  }

  findAll(limit: number, q?: string): Promise<readonly User[]> {
    return this.repository.findAll(limit, q);
  }

  find(id: number): Promise<User | null> {
    return this.repository.find(id);
  }

  create(name: string, tags: readonly string[]): Promise<User> {
    const labels = tags.length === 0 ? '' : ` [${tags.join(', ')}]`;
    this.logger.info(
      `${this.config.get('appName')}: creating ${name}${labels}`,
    );
    return this.repository.create(name);
  }

  async summary(): Promise<string> {
    const users = await this.repository.findAll(50);
    return `${users.length} users: ${users.map((user) => user.name).join(', ')}`;
  }
}
