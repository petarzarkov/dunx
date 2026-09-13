import { describe, expect, it } from 'bun:test';
import { createElement } from 'react';
import { TemplateRenderer } from '../renderer.js';
import renderer, { ReactEmailRenderer, type EmailComponent } from './index.js';

interface WelcomeProps {
  readonly name?: string;
}

/**
 * Declared with its own props, the way a real template is. A component typed as
 * `EmailComponent` directly could not be handed to `createElement`: the
 * contract's parameter is `never` so that any component satisfies it, and that
 * is the one thing `createElement` cannot build an element from.
 */
const Welcome = ({ name }: WelcomeProps) =>
  createElement(
    'html',
    null,
    createElement(
      'body',
      null,
      createElement('h1', null, `Hello ${name ?? ''}`),
    ),
  );
Welcome.PreviewProps = { name: 'Ada' };

describe('ReactEmailRenderer', () => {
  it('renders a component with its props', async () => {
    const rendered = await new ReactEmailRenderer().render(Welcome, {
      name: 'Ada',
    });

    expect(rendered.html).toContain('Hello Ada');
    expect(rendered.html).toContain('<!DOCTYPE html');
  });

  // One template, two bodies: the text alternative cannot describe a different
  // email because it comes from the same element.
  it('produces the plain-text alternative from the same element', async () => {
    const rendered = await new ReactEmailRenderer().render(Welcome, {
      name: 'Ada',
    });

    // React Email's plain-text pass styles a heading as upper case, which is
    // the point: it is a text document and not the markup with tags removed.
    expect(rendered.text).toContain('HELLO ADA');
    expect(rendered.text).not.toContain('<h1>');
  });

  it('renders an element that was already built', async () => {
    const rendered = await new ReactEmailRenderer().render(
      createElement(Welcome, { name: 'Grace' }),
    );

    expect(rendered.html).toContain('Hello Grace');
  });

  it('renders with no props at all', async () => {
    const rendered = await new ReactEmailRenderer().render(Welcome);

    expect(rendered.html).toContain('Hello');
  });

  it('reads React Email PreviewProps off the component', () => {
    expect(new ReactEmailRenderer().previewProps(Welcome)).toEqual({
      name: 'Ada',
    });
  });

  it('has no preview props for a bare element or a bare component', () => {
    const bare: EmailComponent = () => createElement('div');

    expect(
      new ReactEmailRenderer().previewProps(createElement(Welcome, null)),
    ).toEqual({});
    expect(new ReactEmailRenderer().previewProps(bare)).toEqual({});
  });

  // `dunx-email --renderer` loads a module's default export and refuses
  // anything that is not a TemplateRenderer, so this subpath has to have one.
  it('default-exports a ready instance', () => {
    expect(renderer).toBeInstanceOf(TemplateRenderer);
    expect(renderer).toBeInstanceOf(ReactEmailRenderer);
  });
});
