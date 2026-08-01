import { Logger } from '@dunx/core';

interface Call {
  readonly label: string;
  readonly path: string;
  readonly method?: string;
  readonly role?: string;
  readonly body?: unknown;
}

const CALLS: readonly Call[] = [
  {
    label: '@Public() GET /api/reports/health, no credentials',
    path: 'api/reports/health',
  },
  { label: 'GET /api/reports, no credentials', path: 'api/reports' },
  {
    label: 'GET /api/reports as "viewer"',
    path: 'api/reports',
    role: 'viewer',
  },
  {
    label: '@UseGuards(RolesGuard) POST /api/reports as "viewer"',
    path: 'api/reports',
    method: 'POST',
    role: 'viewer',
    body: { title: 'q2 revenue' },
  },
  {
    label: 'POST /api/reports as "admin" (class-level @Roles)',
    path: 'api/reports',
    method: 'POST',
    role: 'admin',
    body: { title: 'q2 revenue' },
  },
  {
    label:
      'PATCH /api/reports/1 as "admin" (method-level @Roles("editor") won)',
    path: 'api/reports/1',
    method: 'PATCH',
    role: 'admin',
    body: { title: 'q1 revenue, restated' },
  },
  {
    label: 'PATCH /api/reports/1 as "editor"',
    path: 'api/reports/1',
    method: 'PATCH',
    role: 'editor',
    body: { title: 'q1 revenue, restated' },
  },
];

export class GuardsDemo {
  constructor(private readonly logger: Logger) {}

  async demonstrate(url: string): Promise<void> {
    for (const call of CALLS) {
      const response = await fetch(new URL(call.path, url), {
        method: call.method ?? 'GET',
        headers: {
          ...(call.role === undefined
            ? {}
            : { authorization: `Bearer ${call.role}` }),
          ...(call.body === undefined
            ? {}
            : { 'content-type': 'application/json' }),
        },
        ...(call.body === undefined ? {} : { body: JSON.stringify(call.body) }),
      });
      this.logger.info(
        `${call.label} -> ${response.status} ${JSON.stringify(await response.json())}`,
      );
    }
  }
}
