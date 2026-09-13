import { render } from '@react-email/components';
import {
  createElement,
  isValidElement,
  type FunctionComponent,
  type ReactElement,
  type ReactNode,
} from 'react';
import { TemplateRenderer, type RenderedEmail } from '../renderer.js';

/**
 * A React Email template: a component, carrying its sample props as a static.
 *
 * The parameter is `never` so that a component declared with its own props type
 * satisfies this. Parameters are contravariant, so `(props: { name: string })`
 * is assignable to `(props: never)` and not to `(props: Record<string,
 * unknown>)`, which would reject every real template.
 */
export interface EmailComponent {
  (props: never): ReactNode;
  PreviewProps?: Record<string, unknown>;
}

export type ReactTemplate = EmailComponent | ReactElement;

/**
 * React Email, through the same `render` an app sends with.
 *
 * Both bodies come from one template: `render` again with `plainText` produces
 * the text alternative, so the two cannot describe different emails.
 */
export class ReactEmailRenderer extends TemplateRenderer<ReactTemplate> {
  async render(
    template: ReactTemplate,
    props: Record<string, unknown> = {},
  ): Promise<RenderedEmail> {
    const element = isValidElement(template)
      ? template
      : createElement(
          template as FunctionComponent<Record<string, unknown>>,
          props,
        );
    const [html, text] = await Promise.all([
      render(element),
      render(element, { plainText: true }),
    ]);
    return { html, text };
  }

  /** React Email's own convention: a `PreviewProps` static on the component. */
  override previewProps(template: ReactTemplate): Record<string, unknown> {
    if (isValidElement(template)) return {};
    return template.PreviewProps ?? {};
  }
}

/** The default export is what `dunx-email --renderer` loads. */
export default new ReactEmailRenderer();
