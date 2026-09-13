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

/**
 * A newline in a field that becomes a header.
 *
 * The subject is a header, and so is every entry in `headers`. A CR or LF in
 * either ends it and starts one the caller never wrote, which is how a `Bcc`
 * gets added to somebody else's message.
 */
export class InvalidHeaderError extends EmailError {
  override readonly status = 400;

  constructor(readonly field: string) {
    super(`Refusing ${field}: it carries a newline, which ends a header.`);
  }
}

/**
 * A mailbox that cannot be put in a header safely.
 *
 * Refused rather than escaped, because there is no escaping that makes a second
 * address inside one recipient mean what the caller wrote.
 */
export class InvalidAddressError extends EmailError {
  override readonly status = 400;

  constructor(
    readonly value: string,
    reason: string,
  ) {
    super(`Refusing the address ${JSON.stringify(value)}: ${reason}.`);
  }
}
