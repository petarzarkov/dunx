import { createTheme, MantineProvider } from '@mantine/core';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '@mantine/core/styles.css';
import '@mantine/charts/styles.css';
import '@mantine/spotlight/styles.css';
import './styles.css';
import './landing.css';
import './generated/shiki.css';
import { App } from './App';

const theme = createTheme({
  primaryColor: 'indigo',
  fontFamilyMonospace:
    'ui-monospace, SFMono-Regular, Menlo, "JetBrains Mono", monospace',
  defaultRadius: 'md',
});

const container = document.getElementById('root');
if (!container) throw new Error('#root is missing from index.html');

createRoot(container).render(
  <StrictMode>
    <MantineProvider theme={theme} defaultColorScheme="auto">
      <App />
    </MantineProvider>
  </StrictMode>,
);
