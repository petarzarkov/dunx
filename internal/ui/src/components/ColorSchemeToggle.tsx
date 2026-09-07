import {
  ActionIcon,
  useComputedColorScheme,
  useMantineColorScheme,
} from '@mantine/core';
import type { JSX } from 'react';
import { MoonIcon, SunIcon } from '../icons.js';

/**
 * The stored scheme starts at `auto`, which is not an answer to "what is on
 * screen" - so reading `colorScheme` here made the first click a no-op: on a
 * dark-OS machine it set `dark`, which was already showing, and only the second
 * click had anywhere to go. `useComputedColorScheme` resolves `auto` against the
 * OS, so the first click always flips what the user is looking at.
 *
 * The API explorer had the buggy version and the documentation site the fixed
 * one, which is the argument for this file existing at all.
 *
 * **Nothing scheme-dependent is rendered.** `internal/docs` now renders every
 * page to HTML at build time, on a machine with no `matchMedia`, so a scheme
 * read during render resolved `light` there and `dark` in a dark-OS browser -
 * one icon in the markup, a different one on the first client render, and a
 * hydration error on every load. The computed scheme is read for the click
 * direction only, where it is a closure rather than markup, and the two icons
 * are switched by Mantine's own `mantine-*-hidden` classes off the
 * `data-mantine-color-scheme` the inlined head script sets before first paint.
 * The label stays put for the same reason.
 */
export const ColorSchemeToggle = (): JSX.Element => {
  const { setColorScheme } = useMantineColorScheme();
  const computed = useComputedColorScheme('light', {
    getInitialValueInEffect: false,
  });

  return (
    <ActionIcon
      variant="default"
      size="lg"
      title="Toggle the colour scheme"
      aria-label="Toggle the colour scheme"
      onClick={() => setColorScheme(computed === 'dark' ? 'light' : 'dark')}
    >
      <MoonIcon className="mantine-dark-hidden" />
      <SunIcon className="mantine-light-hidden" />
    </ActionIcon>
  );
};
