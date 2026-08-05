import articleRoutes from "../data/article-routes.json";

export type PermanentArticleKind = "focus" | "explore";
export type ArticleLocale = "en" | "zh";

type ArticleRoute = {
  key: string;
  kind: PermanentArticleKind;
  id: string;
  slug: string;
  path: string;
  zhPath: string;
};

const routes = articleRoutes.articles as ArticleRoute[];

function withoutLegacyBase(pathname: string) {
  return pathname === "/intelligence"
    ? "/"
    : pathname.startsWith("/intelligence/")
      ? pathname.slice("/intelligence".length)
      : pathname;
}

function legacyBase(pathname: string) {
  return pathname === "/intelligence" ||
    pathname.startsWith("/intelligence/")
    ? "/intelligence"
    : "";
}

export function permanentArticleFromPathname(pathname: string) {
  const normalized = `${withoutLegacyBase(pathname).replace(/\/+$/, "")}/`;
  const locale: ArticleLocale = normalized.startsWith("/zh/") ? "zh" : "en";
  const route = routes.find((entry) =>
    (locale === "zh" ? entry.zhPath : entry.path) === normalized,
  );
  return route ? { ...route, locale } : null;
}

export function permanentArticleById(
  kind: PermanentArticleKind,
  id: number | string,
) {
  return routes.find(
    (route) => route.kind === kind && route.id === String(id),
  ) ?? null;
}

export function permanentArticlePath(
  kind: PermanentArticleKind,
  id: number | string,
  locale: ArticleLocale,
  pathname =
    typeof window === "undefined" ? "/" : window.location.pathname,
) {
  const route = permanentArticleById(kind, id);
  if (!route) return null;
  return `${legacyBase(pathname)}${
    locale === "zh" ? route.zhPath : route.path
  }`;
}
