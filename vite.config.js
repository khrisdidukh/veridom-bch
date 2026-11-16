import { defineConfig } from 'vite';

// Static build into docs/ so GitHub Pages can serve it straight from the main branch.
export default defineConfig({
  base: './',
  build: { outDir: 'docs', emptyOutDir: true, target: 'es2022', chunkSizeWarningLimit: 2500 },
  optimizeDeps: { esbuildOptions: { target: 'es2022' } },
  test: { include: ['test/**/*.test.js'], testTimeout: 60000 },
});
