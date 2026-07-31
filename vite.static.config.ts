import react from "@vitejs/plugin-react";
import { fileURLToPath, URL } from "node:url";
import { defineConfig } from "vite";

const staticRoot = fileURLToPath(new URL("./static", import.meta.url));

export default defineConfig({
  root: staticRoot,
  base: "/intelligence/",
  publicDir: fileURLToPath(new URL("./public", import.meta.url)),
  plugins: [react()],
  build: {
    outDir: fileURLToPath(new URL("./static-dist", import.meta.url)),
    emptyOutDir: true,
    rollupOptions: {
      input: {
        index: fileURLToPath(new URL("./static/index.html", import.meta.url)),
        explore: fileURLToPath(
          new URL("./static/explore/index.html", import.meta.url),
        ),
        conversations: fileURLToPath(
          new URL("./static/conversations/index.html", import.meta.url),
        ),
        sources: fileURLToPath(
          new URL("./static/sources/index.html", import.meta.url),
        ),
      },
    },
  },
});
