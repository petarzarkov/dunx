import { Logger, LogLevel } from '@dunx/core';

/** Silent, so a suite asserting on schedules is not read through boot noise. */
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
