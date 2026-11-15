import { defineConfig } from 'vite';

/**
 * QuillPad 构建配置。
 * - base: './' 保证 dist 产物可以直接静态打开（file:// 或任意静态目录）。
 * - 所有依赖均由 npm 安装并打包进 dist，不引用任何 CDN / 外部 URL。
 */
export default defineConfig({
  base: './',
  server: {
    port: 5173,
    strictPort: false,
  },
  preview: {
    port: 4173,
  },
  build: {
    target: 'es2022',
    outDir: 'dist',
    assetsDir: 'assets',
    sourcemap: false,
    cssCodeSplit: false,
    chunkSizeWarningLimit: 2400,
    // dist/release 存放 electron-builder 的安装包/便携版/卸载器，
    // 与前端产物同处 dist/ 下（不按版本另建 dist-vx-sx 目录）。
    // 若允许 Vite 清空 outDir，重新 build 时会把已有安装包一并删掉，
    // 且 electron-builder 也需在 vite build 之后读取那些文件。
    emptyOutDir: false,
  },
});
