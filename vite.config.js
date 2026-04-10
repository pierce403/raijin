import { resolve } from "node:path";
import { defineConfig } from "vite";

export default defineConfig({
  build: {
    outDir: "dist",
    emptyOutDir: true,
    rollupOptions: {
      input: {
        home: resolve(__dirname, "index.html"),
        session: resolve(__dirname, "session.html"),
        notFound: resolve(__dirname, "404.html"),
      },
    },
  },
});
