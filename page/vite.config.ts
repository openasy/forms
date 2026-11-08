import { defineConfig } from "vite";

// f.js, small and with no dependencies: served as /embed.js, it draws the forms of a page.
export default defineConfig({
  root: import.meta.dirname,
  build: {
    outDir: "../dist/page",
    emptyOutDir: true,
    target: "es2020",
    lib: { entry: "entry.ts", formats: ["iife"], name: "OAF", fileName: () => "f.js" },
  },
});
