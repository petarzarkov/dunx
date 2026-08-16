import { useId } from 'react';

import { ACCENT, BOWL, CROSS } from '../logo.js';

/**
 * The in-page cut: the bowl on `currentColor` so it follows the colour scheme the
 * header is painted in, the cross on the accent gradient. An `<img>` could not do
 * that, which is why the mark is drawn rather than loaded from a file.
 *
 * The geometry comes from `../logo.ts` - it used to be repeated here and in
 * `public/logo/*.svg` with a comment asking whoever changed one to remember the
 * other, which is not a mechanism.
 */

/** `useId` returns delimiters that are not valid in a URL fragment. */
const gradientId = (raw: string): string =>
  `logo-accent-${raw.replace(/[^\w-]/g, '')}`;

const Accent = ({ id }: { id: string }): React.JSX.Element => (
  <linearGradient id={id} x1="0" y1="0" x2="1" y2="1">
    <stop offset="0" stopColor={ACCENT.from} />
    <stop offset="0.5" stopColor={ACCENT.via} />
    <stop offset="1" stopColor={ACCENT.to} />
  </linearGradient>
);

export const LogoMark = ({
  size = 26,
}: {
  size?: number;
}): React.JSX.Element => {
  const id = gradientId(useId());

  return (
    <svg
      viewBox="0 0 32 32"
      width={size}
      height={size}
      fill="none"
      aria-hidden="true"
      focusable="false"
    >
      <Accent id={id} />
      <g strokeWidth="4" strokeLinecap="round">
        <path d={BOWL} stroke="currentColor" />
        <path d={CROSS} stroke={`url(#${id})`} />
      </g>
    </svg>
  );
};

export const Wordmark = ({
  height = 19,
}: {
  height?: number;
}): React.JSX.Element => {
  const id = gradientId(useId());

  return (
    <svg
      viewBox="0 0 100 36"
      width={(height * 100) / 36}
      height={height}
      fill="none"
      aria-hidden="true"
      focusable="false"
    >
      <Accent id={id} />
      <g strokeWidth="4" strokeLinecap="round" strokeLinejoin="round">
        <path d="M22 6v24" stroke="currentColor" />
        <circle cx="14" cy="22" r="8" stroke="currentColor" />
        <path d="M32 14v9a7 7 0 0 0 14 0v7" stroke="currentColor" />
        <path d="M56 30v-9a7 7 0 0 1 14 0v9" stroke="currentColor" />
        <path d="m80 14 14 16m0-16L80 30" stroke={`url(#${id})`} />
      </g>
    </svg>
  );
};
