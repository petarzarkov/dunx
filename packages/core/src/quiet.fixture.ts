import { Logger } from './logger/logger.js';
import { LogLevel } from './logger/types.js';

/**
 * Silent, and keeps what it was told, so a suite asserting on behaviour is not
 * read through boot noise.
 *
 * `@dunx/infra` has one of these too. A test double is not published surface, so
 * core cannot export this for infra to import, and infra's copy is what its own
 * suites resolve.
 */
export class Quiet extends Logger {
  readonly logLevel = LogLevel.DEBUG;
  readonly lines: string[] = [];
  readonly warnings: string[] = [];
  readonly errors: string[] = [];

  override info(message: unknown): void {
    this.lines.push(String(message));
  }
  override log(message: unknown): void {
    this.lines.push(String(message));
  }
  override debug(message: unknown): void {
    this.lines.push(String(message));
  }
  override verbose(message: unknown): void {
    this.lines.push(String(message));
  }
  override warn(message: unknown): void {
    this.warnings.push(String(message));
  }
  override error(message: unknown): void {
    this.errors.push(String(message));
  }
  override fatal(message: unknown): void {
    this.errors.push(String(message));
  }
}
