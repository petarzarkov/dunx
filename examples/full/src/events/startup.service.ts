import { EventBus, type OnInit } from '@dunx/core';
import { AppReady } from './orders.events.js';

/**
 * Emits from `onInit`, from a module imported before `EventBusModule`. It still
 * reaches its subscriber: wiring runs in `onBeforeInit`, before any `onInit`.
 */
export class Startup implements OnInit {
  /** How many subscribers the boot event reached. */
  reached = -1;

  constructor(private readonly bus: EventBus) {}

  async onInit(): Promise<void> {
    this.reached = (await this.bus.emit(new AppReady())).handled;
  }
}
