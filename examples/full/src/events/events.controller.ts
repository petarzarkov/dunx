import { EventRegistry } from '@dunx/core';
import { Controller, Get, Post, type Input } from '@dunx/http';
import { ApiDoc } from '@dunx/openapi';
import { Audit, type AuditRow } from './audit.service.js';
import { listAudit, listSubscriptions, placeOrder } from './events.schemas.js';
import { Orders } from './orders.service.js';

@ApiDoc({
  tags: ['Events'],
  description:
    'The in-process EventBus: one publisher, five @OnEvent subscribers in another module, and what a dispatch reports.',
})
@Controller('events')
export class EventsController {
  constructor(
    private readonly orders: Orders,
    private readonly audit: Audit,
    private readonly registry: EventRegistry,
  ) {}

  /**
   * The response is the dispatch, so a caller can see that a failing subscriber
   * did not fail the request. A total over the review limit makes one throw.
   */
  @Post('/orders', placeOrder)
  async place({ body }: Input<typeof placeOrder>): Promise<{
    event: string;
    handled: number;
    failures: { subscriber: string; error: string }[];
  }> {
    const dispatch = await this.orders.place(body.total);
    return {
      event: dispatch.event,
      handled: dispatch.handled,
      failures: dispatch.failures.map((failure) => ({
        subscriber: failure.subscriber,
        error: String(failure.error),
      })),
    };
  }

  /** Written by a handler, and already there by the time `emit` resolved. */
  @Get('/audit', listAudit)
  auditTrail(): readonly AuditRow[] {
    return this.audit.rows;
  }

  @Get('/subscriptions', listSubscriptions)
  subscriptions(): {
    event: string;
    subscriber: string;
    handled: number;
    failed: number;
  }[] {
    return this.registry.list().map((entry) => ({
      event: entry.event,
      subscriber: entry.subscriber,
      handled: entry.handled,
      failed: entry.failed,
    }));
  }
}
