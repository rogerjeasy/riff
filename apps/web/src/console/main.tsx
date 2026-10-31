import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { FoundationPanel } from '../components/foundation-panel.js';
import '../styles/studio.css';

const root = document.getElementById('root');
if (!root) throw new Error('Missing console root');
createRoot(root).render(
  <StrictMode>
    <FoundationPanel />
  </StrictMode>,
);
