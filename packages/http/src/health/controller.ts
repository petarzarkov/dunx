import { inject } from '@dunx/core';
import { Controller, Get } from '../route/decorators.js';
import { ApiHidden, Public } from '../route/metadata.js';
import { HealthRegistry, type HealthReport } from './registry.js';

const answer = (report: HealthReport): Response =>
  // 503 rather than 500: the process is working and declining traffic, which is
  // what an orchestrator reads to stop routing without restarting.
  Response.json(report, { status: report.status === 'up' ? 200 : 503 });

/**
 * Two routes, not three. A startup probe is already answered by the port: `create()`
 * finishes every `onInit` before `listen()` binds, so a connection refused *is* "not
 * started yet" and a third endpoint would restate it.
 *
 * `@Public()` because a probe has no credentials, and `@ApiHidden()` because these
 * are for the orchestrator rather than for an API consumer. Both are the existing
 * route metadata; there is nothing health-specific about either.
 */
@Controller('health')
@ApiHidden()
export class HealthController {
  /**
   * `inject()` in a field initializer rather than a constructor parameter, because
   * a controller self-binds from `controllers` and a constructor parameter there
   * would need `@dunx/transform`. A class this package **ships** must not require
   * the consumer's compiler plugin to be constructible, and this form works either
   * way. An app's own controllers should take constructor parameters.
   */
  readonly #health = inject(HealthRegistry);

  /**
   * Is the process working. A failure here means restart me.
   *
   * Draining deliberately does not fail this: a pod shutting down does not need
   * killing, and reporting `down` invites a SIGKILL mid-drain.
   */
  @Public()
  @Get('/live')
  async live(): Promise<Response> {
    return answer(await this.#health.liveness());
  }

  /** Should the process receive traffic. Fails from the moment the drain starts. */
  @Public()
  @Get('/ready')
  async ready(): Promise<Response> {
    return answer(await this.#health.readiness());
  }
}
