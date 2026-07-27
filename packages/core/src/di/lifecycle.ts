export interface OnInit {
  onInit(): void | Promise<void>;
}

export interface OnShutdown {
  onShutdown(): void | Promise<void>;
}

const hasMethod = (value: unknown, name: string): boolean =>
  (typeof value === 'object' || typeof value === 'function') &&
  value !== null &&
  typeof (value as Record<string, unknown>)[name] === 'function';

export const hasOnInit = (value: unknown): value is OnInit =>
  hasMethod(value, 'onInit');

export const hasOnShutdown = (value: unknown): value is OnShutdown =>
  hasMethod(value, 'onShutdown');
