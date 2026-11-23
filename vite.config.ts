import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "path";

const host = process.env.TAURI_DEV_HOST;

export default defineConfig(async () => ({
  plugins: [react()],
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "./src"),
    },
  },
  test: {
    environment: "jsdom",
    setupFiles: ["src/test/setup.ts"],
    globals: true,
    // Agent worktrees hold full copies of the repo.
    exclude: ["**/node_modules/**", "**/dist/**", ".claude/**"],
  },
  build: {
    // Vite 6's defaults. Vite 8's need Safari 16.4, but we support macOS 11.
    target: ["es2020", "edge88", "firefox78", "chrome87", "safari14"],
  },
  clearScreen: false,
  server: {
    port: 5173,
    strictPort: false,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 5174,
        }
      : undefined,
    watch: {
      ignored: ["**/src-tauri/**"],
    },
  },
}));
