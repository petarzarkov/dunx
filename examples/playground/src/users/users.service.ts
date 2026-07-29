import type { OnInit, OnShutdown } from '@dunx/core';
import { Config } from '../config.js';
import { Logger } from '../logger.js';
import { UsersRepository, type User } from './users.repository.js';

export class UsersService implements OnInit, OnShutdown {
  constructor(
    private readonly repository: UsersRepository,
    private readonly logger: Logger,
    private readonly config: Config,
  ) {}

  /** `onInit` is awaited, so the schema exists before the first request arrives. */
  async onInit(): Promise<void> {
    await this.repository.migrate();
    await this.repository.seed(this.config.seedUsers);
    this.logger.info(`${this.config.appName}: users ready`);
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
    this.logger.info(`${this.config.appName}: creating ${name}${labels}`);
    return this.repository.create(name);
  }

  async summary(): Promise<string> {
    const users = await this.repository.findAll(50);
    return `${users.length} users: ${users.map((user) => user.name).join(', ')}`;
  }
}
