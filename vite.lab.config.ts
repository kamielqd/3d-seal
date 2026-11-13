import { defineConfig } from 'vite';

/**
 * 验收用构建：只产出 lab/ 下的页面，输出到 dist-lab/，不污染正式 dist/。
 *
 *   node node_modules/vite/bin/vite.js build --config vite.lab.config.ts
 *   node node_modules/vite/bin/vite.js preview --config vite.lab.config.ts --port 4174 --strictPort
 */
export default defineConfig({
  base: './',
  worker: { format: 'es' },
  build: {
    target: 'es2022',
    outDir: 'dist-lab',
    emptyOutDir: true,
    assetsInlineLimit: 0,
    rollupOptions: {
      input: {
        lab: 'lab/trace-lab.html',
        printCheck: 'lab/print-check.html',
      },
    },
  },
  optimizeDeps: {
    exclude: ['manifold-3d'],
  },
});
