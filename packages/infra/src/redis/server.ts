import type { SpanAttributes } from '@dunx/core';

const DEFAULT_PORT = 6379;

/**
 * The attributes every command span carries, read once from the URL: never a
 * key, which is caller data with unbounded cardinality, and never the URL
 * itself, which may carry a password. A unix socket's path is neither a server
 * address nor a database index, so it names only the system.
 */
export const serverOf = (url: string): SpanAttributes => {
  const parsed = new URL(url);
  if (parsed.protocol.endsWith('unix:')) return { 'db.system.name': 'redis' };
  const index = parsed.pathname.slice(1);
  return {
    'db.system.name': 'redis',
    'server.address': parsed.hostname,
    'server.port': Number(parsed.port) || DEFAULT_PORT,
    ...(index === '' ? {} : { 'db.namespace': index }),
  };
};
