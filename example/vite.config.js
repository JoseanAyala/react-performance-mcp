import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { reactPerformanceMcp } from '../src/vite.js';

export default defineConfig({
  plugins: [reactPerformanceMcp(), react()],
  server: { port: 5173, strictPort: true },
});
