// Base design system first; component stylesheets layer on top of it.
import '../styles/studio.css';
import { ProductionTest } from './production/test-frame.js';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { ParticipationPage } from '../participation/page.js';
import { App } from './app.js';
import { RecipeDirectory } from './recipes/directory.js';

const root = document.getElementById('root');
if (!root) throw new Error('Missing console root');
createRoot(root).render(
  <StrictMode>
    {window.location.pathname === '/production-test' ? (
      <ProductionTest />
    ) : window.location.pathname === '/participate' ? (
      <ParticipationPage />
    ) : window.location.pathname === '/recipes' ? (
      <RecipeDirectory />
    ) : (
      <App />
    )}
  </StrictMode>,
);
