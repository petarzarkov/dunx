import type { JSX } from 'react';

/**
 * Four paths, drawn here rather than pulled from an icon package: `@tabler/
 * icons-react` is 20 MB installed and every byte of this bundle is inlined into
 * the page a backend serves.
 */
const svg = (children: JSX.Element, size: number): JSX.Element => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth={1.8}
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    {children}
  </svg>
);

export const LockIcon = ({ size = 16 }: { size?: number }): JSX.Element =>
  svg(
    <>
      <rect x="4" y="10" width="16" height="10" rx="2" />
      <path d="M8 10V7a4 4 0 0 1 8 0v3" />
    </>,
    size,
  );

export const SunIcon = ({ size = 18 }: { size?: number }): JSX.Element =>
  svg(
    <>
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
    </>,
    size,
  );

export const MoonIcon = ({ size = 18 }: { size?: number }): JSX.Element =>
  svg(<path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z" />, size);

export const SendIcon = ({ size = 16 }: { size?: number }): JSX.Element =>
  svg(<path d="M4 12h14M13 6l6 6-6 6" />, size);
