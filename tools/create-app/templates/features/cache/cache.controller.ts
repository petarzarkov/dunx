import {
  Controller,
  Delete,
  Get,
  HttpError,
  HttpStatusCode,
  Put,
  type Input,
} from '@dunx/http';
import { z } from 'zod';
import { Sessions } from './sessions.service.js';

const SessionKey = z
  .object({ id: z.string().min(1).max(80) })
  .meta({ id: 'SessionKey', description: 'A session id' });

const StoreSession = z
  .object({
    data: z.record(z.string(), z.unknown()),
    ttl: z.coerce.number().int().min(1).max(3600).default(60),
  })
  .meta({
    id: 'StoreSession',
    description: 'Session payload and its lifetime',
  });

const oneSession = { params: SessionKey } as const;
const putSession = { params: SessionKey, body: StoreSession } as const;

/**
 * Every route here answers **503 with the connection error's own message** when
 * no Redis is running, rather than 500 - a cache that is not up is a degraded
 * service, not a bug, and `bun start` must still boot without one.
 */
@Controller('cache')
export class CacheController {
  constructor(private readonly sessions: Sessions) {}

  @Get('/', {})
  async status(): Promise<{ url: string; reachable: boolean; note?: string }> {
    return this.sessions.status();
  }

  @Get('/:id', oneSession)
  async read(
    input: Input<typeof oneSession>,
  ): Promise<{ id: string; data: unknown; ttl: number }> {
    const found = await this.degrades(() =>
      this.sessions.read(input.params.id),
    );
    if (found === null) {
      throw new HttpError(
        HttpStatusCode.NOT_FOUND,
        `No session "${input.params.id}"`,
      );
    }
    return found;
  }

  @Put('/:id', putSession)
  store(
    input: Input<typeof putSession>,
  ): Promise<{ id: string; ttl: number; visits: number }> {
    return this.degrades(() =>
      this.sessions.store(input.params.id, input.body.data, input.body.ttl),
    );
  }

  @Delete('/:id', oneSession)
  remove(input: Input<typeof oneSession>): Promise<{ removed: number }> {
    return this.degrades(() => this.sessions.remove(input.params.id));
  }

  private async degrades<T>(run: () => Promise<T>): Promise<T> {
    try {
      return await run();
    } catch (error) {
      // Bun raises some of these synchronously, which is why the wrapper catches
      // around the call rather than relying on the promise rejecting.
      if (error instanceof HttpError) throw error;
      if (!this.sessions.isDown(error)) throw error;
      throw new HttpError(
        HttpStatusCode.SERVICE_UNAVAILABLE,
        `Cache unavailable: ${(error as Error).message}`,
      );
    }
  }
}
