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
 * `getInitialValueInEffect: false` because these are client-only bundles with
 * nothing to hydrate against: the OS preference is readable on the first render,
 * and deferring it to an effect would paint the wrong icon for a frame.
 *
 * The API explorer had the buggy version and the documentation site the fixed
 * one, which is the argument for this file existing at all.
 */
export const ColorSchemeToggle = (): JSX.Element => {
  const { setColorScheme } = useMantineColorScheme();
  const dark =
    useComputedColorScheme('light', { getInitialValueInEffect: false }) ===
    'dark';

  return (
    <ActionIcon
      variant="default"
      size="lg"
      title={dark ? 'Light theme' : 'Dark theme'}
      aria-label={
        dark ? 'Switch to the light theme' : 'Switch to the dark theme'
      }
      onClick={() => setColorScheme(dark ? 'light' : 'dark')}
    >
      {dark ? <SunIcon /> : <MoonIcon />}
    </ActionIcon>
  );
};
