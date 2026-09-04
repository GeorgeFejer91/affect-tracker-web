import { resolve } from "node:path";
import { defineConfig } from "vite";

const desktopRoot = resolve(import.meta.dirname);

export default defineConfig({
  root: desktopRoot,
  publicDir: false,
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    fs: { allow: [resolve(desktopRoot, "..")] },
  },
  build: {
    target: ["es2021", "chrome105"],
    emptyOutDir: true,
    rollupOptions: {
      input: { research: resolve(desktopRoot, "index.html") },
    },
  },
});
