import type { JsonSchema } from '../route/schema.js';

const state: JsonSchema = {
  type: 'string',
  enum: ['up', 'down', 'unknown'],
  description:
    '`unknown` is not `down`: a probe that timed out has told you nothing.',
};

/**
 * `HealthReport`, as a JSON Schema literal.
 *
 * A hand-written schema rather than a zod one, because `RouteSchemas.response`
 * accepts either and this package has no validator dependency to spend on
 * documenting two routes. `$id` hoists it into `components/schemas` once, so both
 * probes and both statuses reference the same definition.
 *
 * It restates the `HealthReport` and `HealthCheckReport` interfaces, which is the
 * one duplicate here: a type is erased and a document needs the shape at runtime.
 * `health.test.ts` asserts the two agree.
 */
export const HEALTH_REPORT_SCHEMA: JsonSchema = Object.freeze({
  $id: 'HealthReport',
  type: 'object',
  description:
    'What the probe found. `up` answers 200 and anything else answers 503.',
  properties: {
    status: state,
    draining: {
      type: 'boolean',
      description: 'The process is shutting down, or something holds it out.',
    },
    uptimeMs: {
      type: 'integer',
      description: 'Measured on a monotonic clock, so it never goes backwards.',
    },
    checks: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          state,
          critical: {
            type: 'boolean',
            description:
              'A failure here sheds traffic. Memory and disk do not.',
          },
          ms: { type: 'integer', description: 'How long the check took.' },
          detail: {
            type: 'string',
            description: 'A latency, a version, or a failure message.',
          },
        },
        required: ['name', 'state', 'critical', 'ms'],
      },
    },
  },
  required: ['status', 'draining', 'uptimeMs', 'checks'],
});
