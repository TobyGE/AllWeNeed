const searchConsoleApi = "https://www.googleapis.com/webmasters/v3";

export const defaultSearchConsoleSites = [
  "sc-domain:allweneed.info",
  "https://allweneed.info/",
];

export class SearchConsoleError extends Error {
  constructor(message, { status = null, code = null } = {}) {
    super(message);
    this.name = "SearchConsoleError";
    this.status = status;
    this.code = code;
  }
}

async function apiRequest(token, path, { method = "GET", body } = {}) {
  const response = await fetch(`${searchConsoleApi}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(body ? { "content-type": "application/json" } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  if (!response.ok) {
    const detail = await response.text();
    let code = null;
    try {
      const parsed = JSON.parse(detail);
      code =
        parsed?.error?.details?.[0]?.reason ??
        parsed?.error?.status ??
        parsed?.error?.errors?.[0]?.reason ??
        null;
    } catch {
      // Preserve the raw response excerpt below.
    }
    throw new SearchConsoleError(
      `Search Console API returned ${response.status}: ${detail.slice(0, 700)}`,
      { status: response.status, code },
    );
  }
  if (response.status === 204) return null;
  const text = await response.text();
  return text ? JSON.parse(text) : null;
}

export function resolveSearchConsoleSite(
  permissionSites,
  preferredSite = process.env.SEARCH_CONSOLE_SITE_URL,
) {
  const available = new Set(
    (permissionSites ?? []).map((item) => item.siteUrl).filter(Boolean),
  );
  if (preferredSite) return available.has(preferredSite) ? preferredSite : null;
  return defaultSearchConsoleSites.find((site) => available.has(site)) ?? null;
}

export async function listSearchConsoleSites(token) {
  const result = await apiRequest(token, "/sites");
  return result?.siteEntry ?? [];
}

export async function listSearchConsoleSitemaps(token, siteUrl) {
  const result = await apiRequest(
    token,
    `/sites/${encodeURIComponent(siteUrl)}/sitemaps`,
  );
  return result?.sitemap ?? [];
}

export async function submitSearchConsoleSitemap(token, siteUrl, sitemapUrl) {
  await apiRequest(
    token,
    `/sites/${encodeURIComponent(siteUrl)}/sitemaps/${encodeURIComponent(sitemapUrl)}`,
    { method: "PUT" },
  );
  return sitemapUrl;
}

export async function querySearchConsole(token, siteUrl, body) {
  return apiRequest(
    token,
    `/sites/${encodeURIComponent(siteUrl)}/searchAnalytics/query`,
    { method: "POST", body },
  );
}

export function searchConsoleStatusFromError(error) {
  if (!(error instanceof SearchConsoleError)) return "api_error";
  if (
    error.status === 401 ||
    error.code === "ACCESS_TOKEN_SCOPE_INSUFFICIENT" ||
    error.code === "insufficientPermissions"
  ) {
    return "authorization_required";
  }
  if (error.status === 403) return "permission_required";
  return "api_error";
}

