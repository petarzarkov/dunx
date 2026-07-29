import type { HttpApp } from '@dunx/http';
import { Sessions } from '../cache/sessions.service.js';
import { ChatDemo } from '../chat/chat.demo.js';
import { Ledger } from '../database/ledger.service.js';
import { DocsDemo } from '../docs/docs.demo.js';
import { HttpDemo } from '../http/http.demo.js';
import { Logger } from '../logger.js';
import { Thumbnails } from '../pictures/thumbnails.service.js';
import { Uploads } from '../storage/uploads.service.js';
import { UsersDemo } from '../users/users.demo.js';

/**
 * The demonstrations, in order, so `main.ts` stays a bootstrap. Every dependency
 * here lives in a feature module of its own; the container is flat, so this can
 * ask for any of them by constructor.
 */
export class Tour {
  constructor(
    private readonly logger: Logger,
    private readonly ledger: Ledger,
    private readonly uploads: Uploads,
    private readonly thumbnails: Thumbnails,
    private readonly sessions: Sessions,
    private readonly users: UsersDemo,
    private readonly http: HttpDemo,
    private readonly chat: ChatDemo,
    private readonly docs: DocsDemo,
  ) {}

  async run(app: HttpApp, url: string): Promise<void> {
    this.logger.group('@dunx/infra/db — drizzle over bun:sqlite at :memory:');
    await this.ledger.demonstrate();

    this.logger.group('@dunx/infra/files — LocalStorage under an OS temp dir');
    await this.uploads.demonstrate();

    this.logger.group('@dunx/infra/images — Bun.Image');
    await this.thumbnails.demonstrate();

    this.logger.group('@dunx/infra/redis — Bun.RedisClient');
    await this.sessions.demonstrate();

    this.logger.group('@dunx/http — zod schemas on the users routes');
    await this.users.demonstrate(url);

    this.logger.group('@dunx/http — app-level configuration');
    await this.http.demonstrate(app, url);

    this.logger.group(
      '@dunx/http — @Gateway("/chat"), same Bun.serve as the routes',
    );
    await this.chat.demonstrate(app, url);

    this.logger.group(
      '@dunx/openapi — the document, from the schemas the routes validate',
    );
    await this.docs.demonstrate(app, url);
  }
}
