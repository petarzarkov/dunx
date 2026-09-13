import { AppError } from '@dunx/core';

/**
 * Base for everything this area throws. `new.target.name` rather than a
 * hardcoded string, so every subclass reports its own name without repeating it.
 */
export class EmailError extends AppError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = new.target.name;
  }
}

/**
 * A transport refused the message. 502 rather than 500: the failure belongs to
 * an upstream this process called, which is what `AppError.status` exists to say
 * without `@dunx/infra` reaching for `@dunx/http`.
 */
export class EmailSendError extends EmailError {
  override readonly status = 502;

  constructor(
    readonly transport: string,
    detail: string,
    options?: ErrorOptions,
  ) {
    super(`${transport} refused the message: ${detail}`, options);
  }
}

/** No `from` on the message and none on the module. */
export class MissingSenderError extends EmailError {
  constructor() {
    super(
      'This message has no "from" and EmailModule was configured without one. ' +
        'Set `from` in the module options, or on the message.',
    );
  }
}

/**
 * Nothing on `to`, `cc` or `bcc`. Caught here rather than at the provider,
 * because an empty `to: []` is a mapping bug and every provider reports it
 * differently.
 */
export class MissingRecipientError extends EmailError {
  override readonly status = 400;

  constructor() {
    super('This message names no recipient on "to", "cc" or "bcc".');
  }
}
