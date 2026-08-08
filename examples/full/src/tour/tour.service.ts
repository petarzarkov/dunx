import { Logger } from '@dunx/core';
import type { HttpApp } from '@dunx/http';
import { AuthDemo } from '../auth/auth.demo.js';
import { Sessions } from '../cache/sessions.service.js';
import { ChatDemo } from '../chat/chat.demo.js';
import { DashboardDemo } from '../dashboard/dashboard.demo.js';
import { Ledger } from '../database/ledger.service.js';
import { DocsDemo } from '../docs/docs.demo.js';
import { GuardsDemo } from '../guards/guards.demo.js';
import { HttpDemo } from '../http/http.demo.js';
import { Thumbnails } from '../pictures/thumbnails.service.js';
import { Uploads } from '../storage/uploads.service.js';
import { UsersDemo } from '../users/users.demo.js';
import { WiringDemo } from '../wiring/wiring.demo.js';

/**
 * The demonstrations, in order, over the one app `bun start` also serves. Every
 * dependency here lives in a feature module of its own; the container is flat,
 * so this can ask for any of them by constructor.
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
    private readonly guards: GuardsDemo,
    private readonly auth: AuthDemo,
    private readonly docs: DocsDemo,
    private readonly wiring: WiringDemo,
    private readonly dashboard: DashboardDemo,
  ) {}

  async run(app: HttpApp, url: string): Promise<void> {
    this.group('@dunx/core - token(), inject() and the three provide() shapes');
    this.wiring.demonstrate();

    this.group('@dunx/infra/db - drizzle over bun:sqlite');
    await this.ledger.demonstrate();

    this.group('@dunx/infra/files - LocalStorage under an OS temp dir');
    await this.uploads.demonstrate();

    this.group('@dunx/infra/images - Bun.Image');
    await this.thumbnails.demonstrate();

    this.group('@dunx/infra/redis - Bun.RedisClient');
    await this.sessions.demonstrate();

    this.group('@dunx/http - zod schemas on the users routes');
    await this.users.demonstrate(url);

    this.group('@dunx/http - app-level configuration');
    await this.http.demonstrate(app, url);

    this.group('@dunx/http - @Gateway("/chat"), same Bun.serve as the routes');
    await this.chat.demonstrate(app, url);

    this.group('@dunx/http - the websocket relay, two nodes, one topic');
    await this.chat.relayed(url);

    this.group('@dunx/http - @Public, @Roles and @UseGuards');
    await this.guards.demonstrate(url);

    this.group('@dunx/auth - better-auth mounted, SessionGuard, AuthContext');
    await this.auth.demonstrate(url);

    this.group('@dunx/openapi - the document, from the routes own zod schemas');
    await this.docs.demonstrate(app, url);

    this.group('@dunx/openapi - security, from the guards own metadata');
    await this.docs.guarded(url);

    this.group('@dunx/dashboard - one page over the running process');
    await this.dashboard.demonstrate(url);
  }

  /** A header, so a reader can tell which area is talking. */
  private group(title: string): void {
    this.logger.info(`--- ${title}`);
  }
}
