import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// base 用相对路径，方便直接丢到 GitHub Pages 的子路径下
export default defineConfig({
  base: './',
  plugins: [react()],
  worker: { format: 'es' },
  build: {
    target: 'es2022',
    assetsInlineLimit: 0,
    chunkSizeWarningLimit: 4096,
  },
  optimizeDeps: {
    // manifold-3d 的 wasm 需要被当作外部资源处理
    exclude: ['manifold-3d'],
  },
});
