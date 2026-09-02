import { Redis } from '@dunx/infra/redis';

/** The session store, on database 1 so a cache flush cannot sign users out. */
export class SessionsRedis extends Redis {}
