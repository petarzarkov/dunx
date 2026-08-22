import { inject } from '@dunx/core';
import { Controller, Get } from '../route/decorators.js';
import { ApiHidden, Public } from '../route/metadata.js';
import { HEALTH_REPORT_SCHEMA } from './report-schema.js';
import { HealthRegistry, type HealthReport } from './registry.js';

/**
 * Both statuses, on both routes. A probe answers the same body either way - the
 * status is the machine-readable half and the report is why.
 */
const probeResponses = {
  response: { 200: HEALTH_REPORT_SCHEMA, 503: HEALTH_REPORT_SCHEMA },
} as const;

const answer = (report: HealthReport): Response =>
  // 503 rather than 500: the process is working and declining traffic, which is
  // what an orchestrator reads to stop routing without restarting.
  Response.json(report, { status: report.status === 'up' ? 200 : 503 });

/**
 * Two routes, not three. A startup probe is already answered by the port: `create()`
 * finishes every `onInit` before `listen()` binds, so a connection refused *is* "not
 * started yet" and a third endpoint would restate it.
 *
 * `@Public()` because a probe has no credentials. Both routes are documented, under
 * the `Health` tag; `HealthModule.forRoot({ documented: false })` mounts
 * {@link HiddenHealthController} instead.
 */
@Controller('health')
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
  @Get('/live', probeResponses)
  async live(): Promise<Response> {
    return answer(await this.#health.liveness());
  }

  /** Should the process receive traffic. Fails from the moment the drain starts. */
  @Public()
  @Get('/ready', probeResponses)
  async ready(): Promise<Response> {
    return answer(await this.#health.readiness());
  }
}

/**
 * The same two routes, kept out of the OpenAPI document.
 *
 * A subclass rather than a flag read when the module is registered, because
 * `@ApiHidden()` writes to the class and a class is shared by every app in the
 * process: `examples/full` boots a second container to demonstrate the websocket
 * relay, so setting the flag at `forRoot` time would leak into the other one. The
 * prefix and both handlers resolve through the prototype chain, so this is the
 * whole implementation.
 */
@ApiHidden()
export class HiddenHealthController extends HealthController {}
