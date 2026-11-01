import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './app.js';
import { RecipeDirectory } from './recipes/directory.js';
import '../styles/studio.css';

const root = document.getElementById('root');
if (!root) throw new Error('Missing console root');
createRoot(root).render(
  <StrictMode>
    {window.location.pathname === '/recipes' ? <RecipeDirectory /> : <App />}
  </StrictMode>,
);
