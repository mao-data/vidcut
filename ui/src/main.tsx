import { createRoot } from 'react-dom/client';
import { App } from './App.js';
import { connectWs } from './ws.js';

connectWs();
const root = document.getElementById('root');
if (root) createRoot(root).render(<App />);
