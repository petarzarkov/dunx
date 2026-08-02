import { useId } from 'react';

/**
 * The mark is the wordmark's own last two letters: the `n` — an arch on two
 * legs — sheltering the `x`. Both cuts are drawn here rather than loaded from
 * `public/logo/`, because an `<img>` cannot inherit `currentColor`, and the
 * neutral stroke has to follow the colour scheme the header is painted in.
 * The geometry is byte-identical to those files; change one, change both.
 */
const ARCH = 'M5.6 26.1V16.3a10.4 10.4 0 0 1 20.8 0v9.8';
const CROSS = 'm11.4 13.1 9.2 9.2m0-9.2-9.2 9.2';

/** `useId` returns delimiters that are not valid in a URL fragment. */
const gradientId = (raw: string): string =>
  `logo-accent-${raw.replace(/[^\w-]/g, '')}`;

const Accent = ({ id }: { id: string }): React.JSX.Element => (
  <linearGradient id={id} x1="0" y1="0" x2="1" y2="1">
    <stop offset="0" stopColor="#22b8cf" />
    <stop offset="0.5" stopColor="#4c6ef5" />
    <stop offset="1" stopColor="#7950f2" />
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
        <path d={ARCH} stroke="currentColor" />
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
