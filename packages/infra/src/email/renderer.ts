import { EmailError } from './errors.js';

export interface RenderedEmail {
  readonly html: string;
  /** The plain-text alternative, when the renderer produces one. */
  readonly text?: string | undefined;
}

/**
 * Turns a template and its props into the two bodies an email carries.
 *
 * The seam exists so React Email is one option rather than the only one: a
 * tagged-template or MJML renderer satisfies the same two methods. `@dunx/infra`
 * ships `ReactEmailRenderer` on `@dunx/infra/email/react`, which is where the
 * `react` and `@react-email/components` peers stay.
 *
 * An abstract class for the same reason {@link EmailTransport} is one.
 */
export abstract class TemplateRenderer<TTemplate = unknown> {
  abstract render(
    template: TTemplate,
    props?: Record<string, unknown>,
  ): Promise<RenderedEmail>;

  /**
   * Sample props for a preview, when the template carries them. React Email's
   * convention is a `PreviewProps` static on the component, and the preview
   * server asks the renderer rather than reading the property itself, so a
   * renderer with a different convention answers for its own templates.
   */
  previewProps(template: TTemplate): Record<string, unknown> {
    void template;
    return {};
  }
}

/**
 * Bound when the module was configured without a renderer, so `sendTemplate`
 * fails with the fix rather than with `undefined is not a function`.
 */
export class UnconfiguredRenderer extends TemplateRenderer {
  render(): Promise<RenderedEmail> {
    return Promise.reject(
      new EmailError(
        'EmailModule was configured without a `renderer`, so there is nothing ' +
          'to render a template with. Pass one, for example ' +
          '`renderer: new ReactEmailRenderer()` from `@dunx/infra/email/react`.',
      ),
    );
  }
}
