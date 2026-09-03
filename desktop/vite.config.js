import { resolve } from "node:path";
import { defineConfig } from "vite";

const desktopRoot = resolve(import.meta.dirname);

export default defineConfig({
  root: desktopRoot,
  publicDir: resolve(desktopRoot, "../site/vendor"),
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    fs: { allow: [resolve(desktopRoot, "..")] },
  },
  build: {
    target: ["es2021", "chrome105", "safari13"],
    emptyOutDir: true,
    rollupOptions: {
      input: {
        settings: resolve(desktopRoot, "index.html"),
        overlay: resolve(desktopRoot, "overlay.html"),
        study: resolve(desktopRoot, "study.html"),
      },
    },
  },
});
