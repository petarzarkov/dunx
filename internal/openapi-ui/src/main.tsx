import { createRoot } from 'react-dom/client';
import './styles';
import { App } from './App';
import { readModel } from './model';

/**
 * The bundle boots from the JSON `@dunx/openapi` wrote into the page. Nothing is
 * fetched to start up, which is the guarantee the package's tests assert.
 */
export const mount = (doc: Document): boolean => {
  const root = doc.getElementById('root');
  const model = readModel(doc);
  if (root === null || model === undefined) return false;
  createRoot(root).render(<App model={model} />);
  return true;
};

mount(document);
