import { createRoot } from 'react-dom/client';
import './styles';
import { App } from './App';
import { readMeta } from './meta';

/**
 * The bundle boots from the JSON `@dunx/dashboard` wrote into the page - the mount
 * path, the poll interval, whether commands are enabled. Everything else is
 * fetched, unlike the API explorer's model: a queue count embedded in HTML would be
 * stale before it painted.
 */
export const mount = (doc: Document): boolean => {
  const root = doc.getElementById('root');
  const meta = readMeta(doc);
  if (root === null || meta === undefined) return false;
  createRoot(root).render(<App meta={meta} />);
  return true;
};

mount(document);
