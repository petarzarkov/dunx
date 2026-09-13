import type { CSSProperties } from 'react';

/**
 * Shared between the templates so the two cannot drift apart, and one directory
 * above them: `dunx-email` renders every module it finds under the templates
 * directory, so anything in there that is not a template is a 500 waiting to be
 * clicked.
 */
export const body: CSSProperties = {
  backgroundColor: '#f1f5f9',
  fontFamily: 'ui-sans-serif, system-ui, sans-serif',
  margin: 0,
  padding: '24px 0',
};

export const container: CSSProperties = {
  backgroundColor: '#ffffff',
  border: '1px solid #e2e8f0',
  borderRadius: 8,
  margin: '0 auto',
  maxWidth: 560,
  padding: 24,
};

export const button: CSSProperties = {
  backgroundColor: '#2563eb',
  borderRadius: 6,
  color: '#ffffff',
  display: 'inline-block',
  padding: '10px 18px',
  textDecoration: 'none',
};

export const muted: CSSProperties = { color: '#64748b', fontSize: 13 };

export const row: CSSProperties = {
  borderBottom: '1px solid #e2e8f0',
  padding: '6px 0',
};

export const total: CSSProperties = { fontWeight: 700, paddingTop: 10 };
