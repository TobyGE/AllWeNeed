import react from "@vitejs/plugin-react";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath, URL } from "node:url";
import { defineConfig } from "vite";
import {
  applyStaticLandingFallback,
  applyArticleMetadata,
  buildArticleCatalog,
} from "./scripts/article-pages.mjs";

const staticRoot = fileURLToPath(new URL("./static", import.meta.url));
const staticBase = process.env.ALL_WE_NEED_STATIC_BASE ?? "/";
const projectRoot = fileURLToPath(new URL(".", import.meta.url));
const outDir = fileURLToPath(new URL("./static-dist", import.meta.url));

function permanentArticlePages() {
  return {
    name: "permanent-article-pages",
    apply: "build",
    async closeBundle() {
      const [radar, existingCatalog] = await Promise.all([
        readFile(resolve(projectRoot, "data/daily-radar.json"), "utf8").then(
          JSON.parse,
        ),
        readFile(resolve(projectRoot, "data/article-routes.json"), "utf8").then(
          JSON.parse,
        ),
      ]);
      const catalog = buildArticleCatalog(radar, existingCatalog);
      const templates = {
        focus: await readFile(resolve(outDir, "focus/index.html"), "utf8"),
        explore: await readFile(resolve(outDir, "explore/index.html"), "utf8"),
      };
      for (const article of catalog.articles) {
        for (const locale of ["en", "zh"] as const) {
          const path = locale === "zh" ? article.zhPath : article.path;
          const outputPath = resolve(outDir, `.${path}`, "index.html");
          await mkdir(dirname(outputPath), { recursive: true });
          await writeFile(
            outputPath,
            applyArticleMetadata(templates[article.kind], article, locale),
          );
        }
      }
      for (const [page, outputPath] of Object.entries({
        home: "index.html",
        live: "live/index.html",
        focus: "focus/index.html",
        explore: "explore/index.html",
        conversations: "conversations/index.html",
        sources: "sources/index.html",
      })) {
        const path = resolve(outDir, outputPath);
        const template = await readFile(path, "utf8");
        await writeFile(
          path,
          applyStaticLandingFallback(template, catalog, page),
        );
      }
    },
  };
}

export default defineConfig({
  root: staticRoot,
  base: staticBase,
  publicDir: fileURLToPath(new URL("./public", import.meta.url)),
  plugins: [react(), permanentArticlePages()],
  build: {
    outDir,
    emptyOutDir: true,
    rollupOptions: {
      input: {
        index: fileURLToPath(new URL("./static/index.html", import.meta.url)),
        live: fileURLToPath(
          new URL("./static/live/index.html", import.meta.url),
        ),
        focus: fileURLToPath(
          new URL("./static/focus/index.html", import.meta.url),
        ),
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
