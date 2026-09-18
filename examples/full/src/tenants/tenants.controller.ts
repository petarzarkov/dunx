import { Controller, Delete, Get, Post, type Input } from '@dunx/http';
import { z } from 'zod';
import type { Rollup, Ticket } from './schema.js';
import { Tenants } from './tenants.service.js';

const TenantPath = z
  .object({
    tenant: z
      .string()
      .min(1)
      .max(40)
      .regex(/^[a-z0-9-]+$/),
  })
  .meta({ id: 'TenantPath', description: 'The key naming a tenant database' });

const oneTenant = { params: TenantPath } as const;
const openTicket = {
  params: TenantPath,
  body: z
    .object({ subject: z.string().min(1).max(120) })
    .meta({ id: 'OpenTicket', description: 'A ticket in one tenant database' }),
} as const;

@Controller('tenants')
export class TenantsController {
  constructor(private readonly tenants: Tenants) {}

  /** Which tenant databases the pool is holding open right now. */
  @Get('/')
  live(): { keys: readonly string[]; size: number } {
    return this.tenants.live();
  }

  @Get('/rollups')
  rollups(): { rollups: readonly Rollup[] } {
    return { rollups: this.tenants.reported() };
  }

  /**
   * The named reporting data source through its other three tokens:
   * `dbOptions`, `dbMetrics` and `dbConnection`.
   */
  @Get('/reporting')
  async reporting(): Promise<{
    backend: string;
    dialect: string;
    queries: number;
    reachable: boolean;
  }> {
    return {
      ...this.tenants.reportingStats(),
      reachable: await this.tenants.ping(),
    };
  }

  @Get('/:tenant/tickets', oneTenant)
  async list({
    params,
  }: Input<typeof oneTenant>): Promise<{ tickets: readonly Ticket[] }> {
    return { tickets: await this.tenants.list(params.tenant) };
  }

  @Post('/:tenant/tickets', openTicket)
  open({ params, body }: Input<typeof openTicket>): Promise<Ticket> {
    return this.tenants.open(params.tenant, body.subject);
  }

  @Post('/:tenant/rollup', oneTenant)
  rollUp({ params }: Input<typeof oneTenant>): Promise<Rollup> {
    return this.tenants.rollUp(params.tenant);
  }

  @Delete('/:tenant', oneTenant)
  async release({
    params,
  }: Input<typeof oneTenant>): Promise<{ released: boolean }> {
    return { released: await this.tenants.release(params.tenant) };
  }
}
