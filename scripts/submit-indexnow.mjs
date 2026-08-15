import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const siteOrigin = "https://allweneed.info";
const indexNowEndpoint = "https://api.indexnow.org/indexnow";
const indexNowKey = "0d9eae99f38781711326cd4cd0072ce2834e5fb6";

export function sitemapUrls(xml) {
  return [...String(xml).matchAll(/<loc>([^<]+)<\/loc>/g)]
    .map((match) => match[1].replaceAll("&amp;", "&"))
    .filter((value) => {
      try {
        return new URL(value).origin === siteOrigin;
      } catch {
        return false;
      }
    });
}

export function indexNowPayload(urlList) {
  return {
    host: "allweneed.info",
    key: indexNowKey,
    keyLocation: `${siteOrigin}/${indexNowKey}.txt`,
    urlList: [...new Set(urlList)],
  };
}

export async function submitIndexNow({
  root = projectRoot,
  fetchImpl = fetch,
} = {}) {
  const sitemap = await readFile(resolve(root, "public/sitemap.xml"), "utf8");
  const payload = indexNowPayload(sitemapUrls(sitemap));
  if (!payload.urlList.length) {
    return { status: "skipped", submittedUrlCount: 0 };
  }
  const response = await fetchImpl(indexNowEndpoint, {
    method: "POST",
    headers: { "content-type": "application/json; charset=utf-8" },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(30_000),
  });
  if (response.status !== 200 && response.status !== 202) {
    const detail = (await response.text()).trim();
    throw new Error(
      `IndexNow returned HTTP ${response.status}${detail ? `: ${detail}` : ""}`,
    );
  }
  return {
    status: response.status === 200 ? "submitted" : "accepted",
    httpStatus: response.status,
    submittedUrlCount: payload.urlList.length,
    submittedAt: new Date().toISOString(),
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  console.log(JSON.stringify(await submitIndexNow(), null, 2));
}
