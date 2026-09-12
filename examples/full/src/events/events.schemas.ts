import type { RouteSchemas } from '@dunx/http';
import { z } from 'zod';

export const PlaceOrder = z
  .object({ total: z.number().min(0) })
  .meta({ id: 'PlaceOrder', description: 'Publish an OrderPlaced event' });

export const Dispatched = z
  .object({
    event: z.string(),
    handled: z.number().int(),
    failures: z.array(z.object({ subscriber: z.string(), error: z.string() })),
  })
  .meta({
    id: 'Dispatched',
    description: 'What one emit() reached, and what failed while it did',
  });

export const AuditRow = z
  .object({ id: z.string(), total: z.number() })
  .meta({ id: 'AuditRow', description: 'A row an event handler wrote' });

export const Subscription = z
  .object({
    event: z.string(),
    subscriber: z.string(),
    handled: z.number().int(),
    failed: z.number().int(),
  })
  .meta({
    id: 'Subscription',
    description: 'One @OnEvent method, as EventRegistry listed it',
  });

export const placeOrder = {
  body: PlaceOrder,
  response: { 201: Dispatched },
} as const satisfies RouteSchemas;

export const listAudit = {
  response: { 200: z.array(AuditRow) },
} as const satisfies RouteSchemas;

export const listSubscriptions = {
  response: { 200: z.array(Subscription) },
} as const satisfies RouteSchemas;
