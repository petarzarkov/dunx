import { Logger } from '@dunx/core';
import { z } from 'zod';
import { CreateUser } from './users.schemas.js';
import { UsersService } from './users.service.js';

const post = (url: string, body: unknown): Promise<Response> =>
  fetch(new URL('api/users', url), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

const show = async (response: Response): Promise<string> =>
  `${response.status} ${JSON.stringify(await response.json())}`;

export class UsersDemo {
  constructor(
    private readonly users: UsersService,
    private readonly logger: Logger,
  ) {}

  async demonstrate(url: string): Promise<void> {
    const { logger } = this;
    logger.info(await this.users.summary());

    const listed = await fetch(new URL('api/users', url));
    logger.info(`GET /api/users -> ${await show(listed)}`);

    const paged = await fetch(new URL('api/users?limit=1&q=ad', url));
    logger.info(
      `GET /api/users?limit=1&q=ad -> ${await show(paged)} (query coerced by zod)`,
    );

    const one = await fetch(new URL('api/users/1', url));
    logger.info(
      `GET /api/users/1 -> ${await show(one)} (params.id coerced to a number)`,
    );

    const created = await post(url, {
      name: 'linus',
      tags: [{ label: 'kernel' }],
    });
    logger.info(`POST /api/users -> ${await show(created)}`);

    // zod rejects, @dunx/http turns the issues into a 400 body.
    const rejected = await post(url, { name: 42 });
    logger.info(`POST /api/users {"name":42} -> ${await show(rejected)}`);

    // A nested issue's path is flattened to dots - the same rendering OpenAPI
    // clients expect.
    const nested = await post(url, { name: 'ada', tags: [{ label: '' }] });
    logger.info(
      `POST /api/users {"tags":[{"label":""}]} -> ${await show(nested)}`,
    );

    // The zod-specific half, and the path OpenAPI generation will take: `id` from
    // .meta() names the $defs entry, `title` lands inline.
    logger.info(
      `z.toJSONSchema(CreateUser) -> ${JSON.stringify(z.toJSONSchema(CreateUser))}`,
    );
  }
}
