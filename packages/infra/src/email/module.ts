import {
  Logger,
  provide,
  type AsyncModuleConfig,
  type Deps,
  type DynamicModule,
} from '@dunx/core';
import { LogTransport } from './log.js';
import { EmailOptions, type EmailOptionsInit } from './options.js';
import { TemplateRenderer, UnconfiguredRenderer } from './renderer.js';
import { EmailService } from './service.js';
import { EmailTransport } from './transport.js';

/**
 * Bound identically by both factories, so `forRootAsync` really is `forRoot`
 * with a factory in front of it.
 *
 * `EmailTransport` and `TemplateRenderer` are bound rather than left to
 * self-bind: an unbound abstract class self-binds into whichever scope asks
 * first, and constructing the contract itself is not a useful failure.
 */
const bindings = [
  provide(EmailTransport, {
    // `dryRun` and "nothing configured" reach the same class, so there is one
    // definition of sending nowhere. The logger comes from the container, which
    // is why the module builds this rather than `EmailOptions` doing it.
    useFactory: (options: EmailOptions, logger: Logger) =>
      options.dryRun || options.transport === undefined
        ? new LogTransport(logger)
        : options.transport,
    inject: [EmailOptions, Logger],
  }),
  provide(TemplateRenderer, {
    useFactory: (options: EmailOptions) =>
      options.renderer ?? new UnconfiguredRenderer(),
    inject: [EmailOptions],
  }),
  provide(EmailService, {
    useFactory: (
      options: EmailOptions,
      transport: EmailTransport,
      renderer: TemplateRenderer,
      logger: Logger,
    ) => new EmailService(options, transport, renderer, logger),
    inject: [EmailOptions, EmailTransport, TemplateRenderer, Logger],
  }),
];

const exported = [EmailOptions, EmailTransport, TemplateRenderer, EmailService];

export class EmailModule {
  /**
   * Binds `EmailOptions`, `EmailTransport`, `TemplateRenderer` and
   * `EmailService`.
   *
   * ```ts
   * @Module({
   *   imports: [EmailModule.forRoot({ from: 'ops@example.com', dryRun: true })],
   * })
   * export class AppModule {}
   * ```
   */
  static forRoot(init: EmailOptionsInit = {}): DynamicModule {
    return {
      module: EmailModule,
      exports: exported,
      providers: [
        provide(EmailOptions, { useValue: new EmailOptions(init) }),
        ...bindings,
      ],
    };
  }

  /**
   * The same four bindings, with the options behind a factory that may await and
   * may itself inject.
   *
   * ```ts
   * EmailModule.forRootAsync({
   *   useFactory: (config: AppConfigService) => ({
   *     transport: new ResendTransport({ apiKey: config.get('email').apiKey }),
   *     from: config.get('email').sender,
   *     maxPerSecond: 2,
   *     dryRun: !config.get('isProd'),
   *   }),
   *   inject: [AppConfigService],
   * });
   * ```
   *
   * `imports` is where the factory's dependencies come from: this dynamic module
   * is its own scope, so importing their module alongside does not reach here.
   */
  static forRootAsync<const D extends Deps>(
    config: AsyncModuleConfig<EmailOptionsInit, D>,
  ): DynamicModule {
    return {
      module: EmailModule,
      ...(config.imports === undefined ? {} : { imports: config.imports }),
      exports: exported,
      providers: [
        provide(EmailOptions, {
          useFactory: async (...deps) =>
            new EmailOptions(await config.useFactory(...deps)),
          inject: config.inject ?? ([] as unknown as D),
        }),
        ...bindings,
      ],
    };
  }
}
