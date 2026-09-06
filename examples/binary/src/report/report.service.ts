import { type OnInit } from '@dunx/core';
import { CliConfigService } from '../config/settings.js';

export interface Report {
  readonly name: string;
  readonly version: string;
  readonly platform: string;
  readonly arch: string;
  readonly bun: string;
  readonly pid: number;
}

/**
 * Injects the config the same way a provider in a server does. `collect` returns
 * plain data so `main.ts` can print it as JSON without this service knowing where
 * the output goes.
 */
export class ReportService implements OnInit {
  #ready = false;

  constructor(private readonly config: CliConfigService) {}

  onInit(): void {
    this.#ready = true;
  }

  collect(): Report {
    if (!this.#ready) throw new Error('report requested before init');
    return {
      name: this.config.get('name'),
      version: this.config.get('version'),
      platform: process.platform,
      arch: process.arch,
      bun: Bun.version,
      pid: process.pid,
    };
  }
}
