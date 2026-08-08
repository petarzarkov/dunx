import type { JSX } from 'react';

/**
 * Inline paths, drawn here rather than pulled from an icon package:
 * `@tabler/icons-react` is 20 MB installed, and two of the three consumers of this
 * package inline their whole bundle into a page a backend serves.
 *
 * One `svg` helper and one path per icon is what keeps the marginal cost of an
 * icon at roughly its `d` attribute. Tree shaking drops the ones a consumer does
 * not name, so this list may grow - what it may not grow is a dependency.
 */
const svg = (
  children: JSX.Element,
  size: number,
  filled = false,
): JSX.Element => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill={filled ? 'currentColor' : 'none'}
    stroke="currentColor"
    strokeWidth={1.8}
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    {children}
  </svg>
);

export interface IconProps {
  readonly size?: number;
}

export const LockIcon = ({ size = 16 }: IconProps): JSX.Element =>
  svg(
    <>
      <rect x="4" y="10" width="16" height="10" rx="2" />
      <path d="M8 10V7a4 4 0 0 1 8 0v3" />
    </>,
    size,
  );

export const SunIcon = ({ size = 18 }: IconProps): JSX.Element =>
  svg(
    <>
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
    </>,
    size,
  );

export const MoonIcon = ({ size = 18 }: IconProps): JSX.Element =>
  svg(<path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z" />, size);

export const SendIcon = ({ size = 16 }: IconProps): JSX.Element =>
  svg(<path d="M4 12h14M13 6l6 6-6 6" />, size);

export const RefreshIcon = ({ size = 16 }: IconProps): JSX.Element =>
  svg(
    <>
      <path d="M20 11A8 8 0 0 0 6.3 6.3L4 8.5" />
      <path d="M4 4v4.5h4.5" />
      <path d="M4 13a8 8 0 0 0 13.7 4.7l2.3-2.2" />
      <path d="M20 20v-4.5h-4.5" />
    </>,
    size,
  );

export const SearchIcon = ({ size = 16 }: IconProps): JSX.Element =>
  svg(
    <>
      <circle cx="11" cy="11" r="6" />
      <path d="m20 20-4.5-4.5" />
    </>,
    size,
  );

export const RetryIcon = ({ size = 16 }: IconProps): JSX.Element =>
  svg(
    <>
      <path d="M4 12a8 8 0 1 1 2.6 5.9" />
      <path d="M4 6v4.5h4.5" />
    </>,
    size,
  );

export const TrashIcon = ({ size = 16 }: IconProps): JSX.Element =>
  svg(
    <>
      <path d="M4 7h16" />
      <path d="M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2" />
      <path d="M6 7l1 12a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1l1-12" />
    </>,
    size,
  );

export const ClockIcon = ({ size = 16 }: IconProps): JSX.Element =>
  svg(
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M12 7.5V12l3 2" />
    </>,
    size,
  );

export const PlugIcon = ({ size = 16 }: IconProps): JSX.Element =>
  svg(
    <>
      <path d="M9 3v5M15 3v5" />
      <path d="M6 8h12v3a6 6 0 0 1-12 0z" />
      <path d="M12 17v4" />
    </>,
    size,
  );

export const BoxIcon = ({ size = 16 }: IconProps): JSX.Element =>
  svg(
    <>
      <path d="M12 3.5 20 8v8l-8 4.5L4 16V8z" />
      <path d="M4 8l8 4.5L20 8M12 12.5V20.5" />
    </>,
    size,
  );

export const RouteIcon = ({ size = 16 }: IconProps): JSX.Element =>
  svg(
    <>
      <circle cx="6" cy="18" r="2.5" />
      <circle cx="18" cy="6" r="2.5" />
      <path d="M8.5 18h5a3.5 3.5 0 0 0 0-7h-3a3.5 3.5 0 0 1 0-7h5" />
    </>,
    size,
  );

export const StackIcon = ({ size = 16 }: IconProps): JSX.Element =>
  svg(
    <>
      <path d="m12 3 9 4.5-9 4.5-9-4.5z" />
      <path d="m3 12 9 4.5 9-4.5" />
      <path d="m3 16.5 9 4.5 9-4.5" />
    </>,
    size,
  );

export const DatabaseIcon = ({ size = 16 }: IconProps): JSX.Element =>
  svg(
    <>
      <ellipse cx="12" cy="6" rx="7.5" ry="3" />
      <path d="M4.5 6v12c0 1.7 3.4 3 7.5 3s7.5-1.3 7.5-3V6" />
      <path d="M4.5 12c0 1.7 3.4 3 7.5 3s7.5-1.3 7.5-3" />
    </>,
    size,
  );

export const AlertIcon = ({ size = 16 }: IconProps): JSX.Element =>
  svg(
    <>
      <path d="M12 4.5 21 19.5H3z" />
      <path d="M12 10v4M12 17h.01" />
    </>,
    size,
  );
