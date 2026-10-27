import React from 'react';
import { createRoot } from 'react-dom/client';
import './styles/index.css';
import App from './App.jsx';
import { ErrorBoundary } from './shell/ErrorBoundary.jsx';
import { ConfirmHost } from './lib/confirm.jsx';

createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <ErrorBoundary variant="app">
      <App />
      <ConfirmHost />
    </ErrorBoundary>
  </React.StrictMode>,
);
