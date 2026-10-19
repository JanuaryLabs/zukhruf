import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { Playground } from './playground.tsx';
import './styles.css';

const root = document.getElementById('root');
if (!root) {
  throw new Error('index.html has no #root element');
}
createRoot(root).render(
  <StrictMode>
    <Playground />
  </StrictMode>,
);
