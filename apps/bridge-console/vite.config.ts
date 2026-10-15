import tailwindcss from "@tailwindcss/vite";
import { svelte } from "@sveltejs/vite-plugin-svelte";
import { defineConfig } from "vite";

export default defineConfig({
  base: "./",
  plugins: [
    tailwindcss(),
    svelte({
      compilerOptions: {
        runes: true,
      },
    }),
  ],
  server: {
    host: "127.0.0.1",
    port: 5174,
    strictPort: true,
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
});
