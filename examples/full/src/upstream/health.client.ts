import { HttpService } from '@dunx/http/client';

/** A probe client with its own short timeout, taken as a parameter. */
export class HealthClient extends HttpService {}
