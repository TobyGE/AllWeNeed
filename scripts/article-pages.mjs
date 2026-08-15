import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const siteOrigin = "https://allweneed.info";
const exploreEditorialFloor = 80;

function validDate(...values) {
  for (const value of values) {
    const timestamp = Date.parse(value ?? "");
    if (Number.isFinite(timestamp)) return new Date(timestamp).toISOString();
  }
  return new Date(0).toISOString();
}

export function slugify(value) {
  return String(value)
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 72) || "story";
}

function localizedEvidence(baseEvidence = [], translatedEvidence = []) {
  return baseEvidence.map((evidence, index) => ({
    ...evidence,
    role: translatedEvidence[index]?.role ?? evidence.role,
    takeaway: translatedEvidence[index]?.takeaway ?? evidence.takeaway,
  }));
}

function localizedSignal(radar, signal, index, locale) {
  const translated = radar.translations?.[locale]?.signals?.[index] ?? {};
  return {
    ...signal,
    ...translated,
    article: translated.article
      ? {
          ...signal.article,
          ...translated.article,
          sections:
            translated.article.sections ?? signal.article?.sections ?? [],
        }
      : signal.article,
    evidence: localizedEvidence(signal.evidence, translated.evidence),
  };
}

function localizedExplore(radar, signal, index, locale) {
  const translated =
    radar.translations?.[locale]?.exploreSignals?.[index] ?? {};
  return {
    ...signal,
    ...translated,
    article: translated.article
      ? {
          ...signal.article,
          ...translated.article,
          sections:
            translated.article.sections ?? signal.article?.sections ?? [],
        }
      : signal.article,
    evidence: localizedEvidence(signal.evidence, translated.evidence),
  };
}

function mergeExploreStories(radar, locale) {
  const localizedSignals = (radar.signals ?? []).map((signal, index) =>
    localizedSignal(radar, signal, index, locale),
  );
  const curated = (radar.exploreSignals ?? []).map((signal, index) =>
    localizedExplore(radar, signal, index, locale),
  );
  const storySignals = localizedSignals
    .filter((signal) => signal.editorialBucket === "explore")
    .map((signal) => ({
      ...signal,
      id: String(signal.id),
      label: signal.eyebrow,
      thesis: signal.summary,
      whyNow: signal.why,
      counterpoint: signal.impact,
      valueScore: signal.score,
    }));
  const linkedCuratedIds = new Set();
  const mergedStories = storySignals.map((signal) => {
    const related = curated.filter(
      (item) => item.relatedSignalId === Number(signal.id),
    );
    related.forEach((item) => linkedCuratedIds.add(item.id));
    const evidence = [...signal.evidence, ...related.flatMap((item) => item.evidence)]
      .filter(
        (item, index, items) =>
          items.findIndex((candidate) => candidate.url === item.url) === index,
      );
    return {
      ...signal,
      valueScore: Math.max(
        Number(signal.valueScore ?? 0),
        ...related.map((item) => Number(item.valueScore ?? 0)),
      ),
      evidence,
      crossValidation: [
        signal.crossValidation,
        ...related.map((item) => item.crossValidation),
      ]
        .filter(Boolean)
        .join(" "),
    };
  });
  const storyEvidenceUrls = new Set(
    mergedStories.flatMap((signal) =>
      signal.evidence.map((evidence) => evidence.url),
    ),
  );
  const standalone = curated.filter(
    (signal) =>
      !linkedCuratedIds.has(signal.id) &&
      !signal.evidence.some((evidence) =>
        storyEvidenceUrls.has(evidence.url),
      ),
  );
  return [...mergedStories, ...standalone].filter(
    (signal) => Number(signal.valueScore ?? signal.score ?? 0) >=
      exploreEditorialFloor,
  );
}

function articleTimestamp(item, generatedAt) {
  return validDate(
    item.publishedAt,
    item.feedBatchAt,
    ...(item.evidence ?? []).map((evidence) => evidence.publishedAt),
    item.updatedAt,
    generatedAt,
  );
}

function fallbackArticle(item, locale) {
  const summary = item.summary ?? item.thesis ?? "";
  const why = item.why ?? item.whyNow ?? "";
  const impact = item.impact ?? item.counterpoint ?? "";
  return {
    lead: summary,
    sections: [
      {
        heading: locale === "zh" ? "发生了什么" : "What happened",
        body: item.crossValidation ?? summary,
      },
      {
        heading: locale === "zh" ? "为什么重要" : "Why it matters",
        body: why,
      },
      {
        heading: locale === "zh" ? "可能带来的变化" : "Potential impact",
        body: impact,
      },
    ],
    outlook: impact,
  };
}

function uniqueSlug(title, id, usedSlugs) {
  const base = slugify(title);
  const suffix = slugify(id).slice(-18);
  let candidate = `${base}-${suffix}`;
  let index = 2;
  while (usedSlugs.has(candidate)) {
    candidate = `${base}-${suffix}-${index}`;
    index += 1;
  }
  usedSlugs.add(candidate);
  return candidate;
}

export function buildArticleCatalog(radar, previousCatalog = { articles: [] }) {
  const previousByKey = new Map(
    (previousCatalog.articles ?? []).map((entry) => [entry.key, entry]),
  );
  const usedSlugs = new Set();
  const articles = [];
  const focusEn = (radar.signals ?? [])
    .map((signal, index) => ({ signal, index }))
    .filter(({ signal }) => signal.editorialBucket === "dynamic");

  for (const { signal, index } of focusEn) {
    const en = localizedSignal(radar, signal, index, "en");
    const zh = localizedSignal(radar, signal, index, "zh");
    const key = `focus:${signal.id}`;
    const previous = previousByKey.get(key);
    const slug = previous?.slug ??
      uniqueSlug(en.title ?? signal.title, signal.id, usedSlugs);
    usedSlugs.add(slug);
    articles.push({
      key,
      kind: "focus",
      id: String(signal.id),
      slug,
      path: `/focus/${slug}/`,
      zhPath: `/zh/focus/${slug}/`,
      publishedAt: articleTimestamp(signal, radar.generatedAt),
      updatedAt: validDate(signal.updatedAt, signal.feedBatchAt, radar.generatedAt),
      locales: {
        en: {
          category: en.category,
          eyebrow: en.eyebrow,
          title: en.title,
          description: en.summary,
          why: en.why,
          impact: en.impact,
          crossValidation: en.crossValidation,
          article: en.article ?? fallbackArticle(en, "en"),
          evidence: en.evidence ?? [],
        },
        zh: {
          category: zh.category,
          eyebrow: zh.eyebrow,
          title: zh.title,
          description: zh.summary,
          why: zh.why,
          impact: zh.impact,
          crossValidation: zh.crossValidation,
          article: zh.article ?? fallbackArticle(zh, "zh"),
          evidence: zh.evidence ?? [],
        },
      },
    });
  }

  const exploreEn = mergeExploreStories(radar, "en");
  const exploreZh = new Map(
    mergeExploreStories(radar, "zh").map((item) => [String(item.id), item]),
  );
  for (const en of exploreEn) {
    const zh = exploreZh.get(String(en.id)) ?? en;
    const key = `explore:${en.id}`;
    const previous = previousByKey.get(key);
    const slug = previous?.slug ??
      uniqueSlug(en.title, en.id, usedSlugs);
    usedSlugs.add(slug);
    articles.push({
      key,
      kind: "explore",
      id: String(en.id),
      slug,
      path: `/explore/${slug}/`,
      zhPath: `/zh/explore/${slug}/`,
      publishedAt: articleTimestamp(en, radar.generatedAt),
      updatedAt: validDate(en.updatedAt, en.feedBatchAt, radar.generatedAt),
      locales: {
        en: {
          category: en.category,
          eyebrow: en.label,
          title: en.title,
          description: en.thesis,
          why: en.whyNow,
          impact: en.counterpoint,
          crossValidation: en.crossValidation,
          article: en.article ?? fallbackArticle(en, "en"),
          evidence: en.evidence ?? [],
        },
        zh: {
          category: zh.category,
          eyebrow: zh.label,
          title: zh.title,
          description: zh.thesis,
          why: zh.whyNow,
          impact: zh.counterpoint,
          crossValidation: zh.crossValidation,
          article: zh.article ?? fallbackArticle(zh, "zh"),
          evidence: zh.evidence ?? [],
        },
      },
    });
  }

  return {
    generatedAt: radar.generatedAt,
    articles: articles.sort((left, right) =>
      right.updatedAt.localeCompare(left.updatedAt),
    ),
  };
}

export function compactArticleCatalog(catalog) {
  return {
    generatedAt: catalog.generatedAt,
    articles: catalog.articles.map(
      ({ key, kind, id, slug, path, zhPath }) => ({
        key,
        kind,
        id,
        slug,
        path,
        zhPath,
      }),
    ),
  };
}

export function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function escapeXml(value) {
  return escapeHtml(value);
}

function sitemapUrl(path, lastmod, alternates = true) {
  const alternateLinks = alternates
    ? [
        `    <xhtml:link rel="alternate" hreflang="en" href="${siteOrigin}${escapeXml(path)}" />`,
        `    <xhtml:link rel="alternate" hreflang="zh-CN" href="${siteOrigin}/zh${escapeXml(path)}" />`,
        `    <xhtml:link rel="alternate" hreflang="x-default" href="${siteOrigin}${escapeXml(path)}" />`,
      ].join("\n")
    : "";
  return [
    "  <url>",
    `    <loc>${siteOrigin}${escapeXml(path)}</loc>`,
    lastmod ? `    <lastmod>${escapeXml(lastmod.slice(0, 10))}</lastmod>` : "",
    alternateLinks,
    "  </url>",
  ].filter(Boolean).join("\n");
}

export function renderSitemap(catalog) {
  const staticPaths = [
    "/",
    "/focus/",
    "/explore/",
    "/conversations/",
    "/sources/",
    "/about/",
    "/editorial-standards/",
    "/topics/",
  ];
  const urls = staticPaths.map((path) => sitemapUrl(path, null, false));
  for (const topic of topicDefinitions) {
    const latest = articlesForTopic(catalog, topic)[0];
    urls.push(
      sitemapUrl(`/topics/${topic.slug}/`, latest?.updatedAt ?? null, false),
    );
  }
  for (const article of catalog.articles) {
    urls.push(sitemapUrl(article.path, article.updatedAt));
    urls.push(
      sitemapUrl(article.zhPath, article.updatedAt, false),
    );
  }
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">',
    ...urls,
    "</urlset>",
    "",
  ].join("\n");
}

export function renderNewsSitemap(catalog, now = catalog.generatedAt) {
  const cutoff = Date.parse(now) - 2 * 24 * 60 * 60 * 1_000;
  const recent = catalog.articles.filter(
    (article) =>
      article.kind === "focus" && Date.parse(article.publishedAt) >= cutoff,
  );
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:news="http://www.google.com/schemas/sitemap-news/0.9">',
    ...recent.map((article) => [
      "  <url>",
      `    <loc>${siteOrigin}${escapeXml(article.path)}</loc>`,
      "    <news:news>",
      "      <news:publication>",
      "        <news:name>All We Need</news:name>",
      "        <news:language>en</news:language>",
      "      </news:publication>",
      `      <news:publication_date>${escapeXml(article.publishedAt)}</news:publication_date>`,
      `      <news:title>${escapeXml(article.locales.en.title)}</news:title>`,
      "    </news:news>",
      "  </url>",
    ].join("\n")),
    "</urlset>",
    "",
  ].join("\n");
}

export function renderRssFeed(catalog) {
  const latest = catalog.articles.slice(0, 100);
  const lastBuildDate = new Date(
    latest[0]?.updatedAt ?? catalog.generatedAt ?? Date.now(),
  ).toUTCString();
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">',
    "  <channel>",
    "    <title>All We Need — AI &amp; Tech Intelligence</title>",
    `    <link>${siteOrigin}/</link>`,
    "    <description>Independent AI and technology intelligence with cross-validated analysis and original sources.</description>",
    "    <language>en-US</language>",
    `    <lastBuildDate>${escapeXml(lastBuildDate)}</lastBuildDate>`,
    `    <atom:link href="${siteOrigin}/feed.xml" rel="self" type="application/rss+xml" />`,
    ...latest.map((article) => {
      const copy = article.locales.en;
      const url = `${siteOrigin}${article.path}`;
      return [
        "    <item>",
        `      <title>${escapeXml(copy.title)}</title>`,
        `      <link>${escapeXml(url)}</link>`,
        `      <guid isPermaLink="true">${escapeXml(url)}</guid>`,
        `      <pubDate>${escapeXml(new Date(article.publishedAt).toUTCString())}</pubDate>`,
        `      <description>${escapeXml(copy.description)}</description>`,
        `      <category>${escapeXml(article.kind === "focus" ? "Focus" : "Explore")}</category>`,
        "    </item>",
      ].join("\n");
    }),
    "  </channel>",
    "</rss>",
    "",
  ].join("\n");
}

const staticPageCopy = {
  home: {
    eyebrow: "Independent intelligence",
    title: "AI and technology signals worth your attention",
    description:
      "A continuously updated intelligence feed built from public sources, cross-validation, and editorial judgment.",
  },
  live: {
    eyebrow: "Continuous feed",
    title: "What is happening now",
    description:
      "Recent AI, technology, and investment updates traced back to their original public sources.",
  },
  focus: {
    eyebrow: "Focus",
    title: "Consequential shifts that survived cross-validation",
    description:
      "The AI, technology, and investment developments most likely to matter beyond today’s news cycle.",
  },
  explore: {
    eyebrow: "Explore",
    title: "Early theses and second-order effects",
    description:
      "Evidence-led arguments about changes that are still taking shape and have not reached consensus.",
  },
  conversations: {
    eyebrow: "Podcasts",
    title: "The long conversations worth your time",
    description:
      "Concise editorial notes on interviews and podcasts with durable ideas, useful detail, and clear limitations.",
  },
  sources: {
    eyebrow: "Sources",
    title: "The public sources behind All We Need",
    description:
      "A transparent view of the official, research, media, and independent sources monitored by the radar.",
  },
};

export const topicDefinitions = [
  {
    slug: "openai",
    title: "OpenAI",
    description:
      "OpenAI product releases, models, enterprise moves, safety decisions, and the competitive consequences around them.",
    patterns: [/\bopenai\b/i, /\bgpt[-\s]/i, /\bcodex\b/i],
  },
  {
    slug: "anthropic-claude",
    title: "Anthropic & Claude",
    description:
      "Anthropic and Claude releases, research, policy choices, partnerships, and business signals.",
    patterns: [/\banthropic\b/i, /\bclaude\b/i],
  },
  {
    slug: "google-gemini",
    title: "Google, Gemini & DeepMind",
    description:
      "Google AI, Gemini, and DeepMind model releases, research, products, and platform strategy.",
    patterns: [/\bgoogle\b/i, /\bgemini\b/i, /\bdeepmind\b/i],
  },
  {
    slug: "open-models",
    title: "Open Models",
    description:
      "Open-weight and open-source model releases, including Qwen, DeepSeek, Llama, and the ecosystems forming around them.",
    patterns: [
      /\bqwen\b/i,
      /\bdeepseek\b/i,
      /\bllama\b/i,
      /\bhugging face\b/i,
      /open[-\s](?:weight|source)/i,
    ],
  },
  {
    slug: "ai-agents",
    title: "AI Agents",
    description:
      "Agentic systems, coding agents, tool use, memory, reliability, and the shift from assistance to execution.",
    patterns: [/\bagent(?:ic|s)?\b/i, /coding agent/i, /tool use/i],
  },
  {
    slug: "chips-compute",
    title: "Chips & AI Compute",
    description:
      "Semiconductors, accelerators, memory, data centers, energy, and the economics of AI infrastructure.",
    patterns: [
      /\bnvidia\b/i,
      /\bamd\b/i,
      /\btsmc\b/i,
      /\bchip(?:s)?\b/i,
      /semiconductor/i,
      /data cent(?:er|re)/i,
      /\bcompute\b/i,
      /\bmemory\b/i,
    ],
  },
  {
    slug: "robotics",
    title: "Robotics",
    description:
      "Robotics, embodied intelligence, humanoids, world models, and the data bottlenecks between simulation and deployment.",
    patterns: [/\brobot(?:ics|s)?\b/i, /\bhumanoid/i, /embodied/i],
  },
  {
    slug: "ai-safety-security",
    title: "AI Safety & Security",
    description:
      "AI safety, cybersecurity, model governance, misuse, evaluations, incidents, and defensive applications.",
    patterns: [
      /\bsafety\b/i,
      /\bsecurity\b/i,
      /\bcyber/i,
      /governance/i,
      /\brisk(?:s)?\b/i,
      /watermark/i,
    ],
  },
];

function articleTopicText(article) {
  const copy = article.locales.en;
  return [
    copy.title,
    copy.description,
    copy.category,
    copy.eyebrow,
    copy.why,
    copy.impact,
  ].filter(Boolean).join(" ");
}

export function articlesForTopic(catalog, topic) {
  return catalog.articles.filter((article) =>
    topic.patterns.some((pattern) => pattern.test(articleTopicText(article))),
  );
}

function topicCards(catalog) {
  return topicDefinitions.map((topic) => ({
    ...topic,
    articles: articlesForTopic(catalog, topic),
  }));
}

function staticPageJsonLd(value) {
  return JSON.stringify(value).replaceAll("<", "\\u003c");
}

function staticPageShell({ eyebrow, title, description, body }) {
  return [
    '<main class="editorial-page">',
    '  <header class="editorial-page-header">',
    '    <a class="seo-fallback-brand" href="/">All We Need</a>',
    '    <nav aria-label="Primary">',
    '      <a href="/focus/">Focus</a>',
    '      <a href="/explore/">Explore</a>',
    '      <a href="/topics/">Topics</a>',
    '      <a href="/about/">About</a>',
    '      <a href="/feed.xml">RSS</a>',
    "    </nav>",
    "  </header>",
    '  <section class="editorial-page-hero">',
    `    <p>${escapeHtml(eyebrow)}</p>`,
    `    <h1>${escapeHtml(title)}</h1>`,
    `    <p>${escapeHtml(description)}</p>`,
    "  </section>",
    body,
    '  <footer class="editorial-page-footer">',
    '    <a href="/editorial-standards/">Editorial standards &amp; corrections</a>',
    '    <a href="https://github.com/TobyGE/AllWeNeed/issues">Contact and report an issue</a>',
    "  </footer>",
    "</main>",
  ].join("\n");
}

function applyStaticPageMetadata(template, { title, description, path, jsonLd, body }) {
  const canonical = `${siteOrigin}${path}`;
  return template
    .replace(/<title>[\s\S]*?<\/title>/, `<title>${escapeHtml(title)} — All We Need</title>`)
    .replace(
      /<meta\s+name="description"\s+content="[\s\S]*?"\s*\/>/,
      `<meta name="description" content="${escapeHtml(description)}" />`,
    )
    .replace(
      /<meta property="og:title" content="[\s\S]*?" \/>/,
      `<meta property="og:title" content="${escapeHtml(title)} — All We Need" />`,
    )
    .replace(
      /<meta\s+property="og:description"\s+content="[\s\S]*?"\s*\/>/,
      `<meta property="og:description" content="${escapeHtml(description)}" />`,
    )
    .replace(
      /<link\s+rel="canonical"\s+href="[^"]*"\s*\/>/,
      `<link rel="canonical" href="${canonical}" />`,
    )
    .replace(
      /<meta\s+property="og:url"\s+content="[^"]*"\s*\/>/,
      `<meta property="og:url" content="${canonical}" />`,
    )
    .replace(
      "</head>",
      `    <script type="application/ld+json">${staticPageJsonLd(jsonLd)}</script>\n  </head>`,
    )
    .replace(/<main id="static-content">[\s\S]*?<\/main>/, body);
}

export function applyTopicIndex(template, catalog) {
  const topics = topicCards(catalog);
  const body = staticPageShell({
    eyebrow: "Topic index",
    title: "Follow the systems changing AI and technology",
    description:
      "Stable topic pages connect fast-moving stories into durable research trails, with every claim linked back to its original sources.",
    body: [
      '<section class="topic-card-grid">',
      ...topics.map((topic) => [
        "  <article>",
        `    <p>${topic.articles.length} articles</p>`,
        `    <h2><a href="/topics/${topic.slug}/">${escapeHtml(topic.title)}</a></h2>`,
        `    <p>${escapeHtml(topic.description)}</p>`,
        "  </article>",
      ].join("\n")),
      "</section>",
    ].join("\n"),
  });
  return applyStaticPageMetadata(template, {
    title: "AI & Technology Topics",
    description:
      "Browse All We Need research trails across frontier AI labs, open models, agents, chips, robotics, safety, and security.",
    path: "/topics/",
    jsonLd: {
      "@context": "https://schema.org",
      "@type": "CollectionPage",
      name: "All We Need Topics",
      url: `${siteOrigin}/topics/`,
      hasPart: topics.map((topic) => ({
        "@type": "CollectionPage",
        name: topic.title,
        url: `${siteOrigin}/topics/${topic.slug}/`,
      })),
    },
    body,
  });
}

export function applyTopicPage(template, catalog, topic) {
  const articles = articlesForTopic(catalog, topic).slice(0, 40);
  const path = `/topics/${topic.slug}/`;
  const body = staticPageShell({
    eyebrow: `${articles.length} linked articles`,
    title: topic.title,
    description: topic.description,
    body: [
      '<section class="topic-story-list">',
      "  <h2>Latest intelligence</h2>",
      ...articles.map((article) => {
        const copy = article.locales.en;
        return [
          "  <article>",
          `    <p>${article.kind === "focus" ? "Focus" : "Explore"} · <time datetime="${escapeHtml(article.updatedAt)}">${escapeHtml(article.updatedAt.slice(0, 10))}</time></p>`,
          `    <h3><a href="${escapeHtml(article.path)}">${escapeHtml(copy.title)}</a></h3>`,
          `    <p>${escapeHtml(copy.description)}</p>`,
          `    <a class="topic-zh-link" href="${escapeHtml(article.zhPath)}">中文版</a>`,
          "  </article>",
        ].join("\n");
      }),
      "</section>",
    ].join("\n"),
  });
  return applyStaticPageMetadata(template, {
    title: topic.title,
    description: topic.description,
    path,
    jsonLd: {
      "@context": "https://schema.org",
      "@type": "CollectionPage",
      name: topic.title,
      description: topic.description,
      url: `${siteOrigin}${path}`,
      mainEntity: {
        "@type": "ItemList",
        itemListElement: articles.map((article, index) => ({
          "@type": "ListItem",
          position: index + 1,
          url: `${siteOrigin}${article.path}`,
          name: article.locales.en.title,
        })),
      },
    },
    body,
  });
}

export function staticLandingFallbackHtml(catalog, page = "home") {
  const copy = staticPageCopy[page] ?? staticPageCopy.home;
  const kind = page === "focus" || page === "explore" ? page : null;
  const articles = catalog.articles
    .filter((article) => !kind || article.kind === kind)
    .slice(0, page === "home" ? 24 : 36);
  return [
    '<main class="seo-fallback">',
    '  <header class="seo-fallback-header">',
    '    <a class="seo-fallback-brand" href="/">All We Need</a>',
    '    <nav aria-label="Primary">',
    '      <a href="/focus/">Focus</a>',
    '      <a href="/explore/">Explore</a>',
    '      <a href="/conversations/">Podcasts</a>',
    '      <a href="/sources/">Sources</a>',
    '      <a href="/topics/">Topics</a>',
    '      <a href="/about/">About</a>',
    '      <a href="/feed.xml">RSS</a>',
    "    </nav>",
    "  </header>",
    '  <section class="seo-fallback-hero">',
    `    <p>${escapeHtml(copy.eyebrow)}</p>`,
    `    <h1>${escapeHtml(copy.title)}</h1>`,
    `    <p>${escapeHtml(copy.description)}</p>`,
    "  </section>",
    ...(articles.length
      ? [
          '  <section class="seo-fallback-stories">',
          "    <h2>Latest intelligence</h2>",
          '    <div class="seo-fallback-grid">',
          ...articles.map((article) => {
            const articleCopy = article.locales.en;
            return [
              "      <article>",
              `        <p>${article.kind === "focus" ? "Focus" : "Explore"} · <time datetime="${escapeHtml(article.updatedAt)}">${escapeHtml(article.updatedAt.slice(0, 10))}</time></p>`,
              `        <h3><a href="${escapeHtml(article.path)}">${escapeHtml(articleCopy.title)}</a></h3>`,
              `        <p>${escapeHtml(articleCopy.description)}</p>`,
              "      </article>",
            ].join("\n");
          }),
          "    </div>",
          "  </section>",
        ]
      : []),
    '  <footer class="seo-fallback-footer">',
    '    <a href="/feed.xml">Subscribe via RSS</a>',
    "    <span>Independent intelligence · Original sources preserved</span>",
    "  </footer>",
    "</main>",
  ].join("\n");
}

export function applyStaticLandingFallback(template, catalog, page) {
  return template.replace(
    '<div id="root"></div>',
    `<div id="root">${staticLandingFallbackHtml(catalog, page)}</div>`,
  );
}

export function articleJsonLd(article, locale) {
  const copy = article.locales[locale];
  const path = locale === "zh" ? article.zhPath : article.path;
  return {
    "@context": "https://schema.org",
    "@type": article.kind === "focus" ? "NewsArticle" : "Article",
    headline: copy.title,
    description: copy.description,
    datePublished: article.publishedAt,
    dateModified: article.updatedAt,
    inLanguage: locale === "zh" ? "zh-CN" : "en",
    mainEntityOfPage: `${siteOrigin}${path}`,
    author: {
      "@type": "Organization",
      name: "All We Need Editorial System",
      url: `${siteOrigin}/editorial-standards/`,
    },
    publisher: {
      "@type": "Organization",
      name: "All We Need",
      logo: {
        "@type": "ImageObject",
        url: `${siteOrigin}/apple-touch-icon.png`,
      },
    },
    image: [`${siteOrigin}/og.png`],
  };
}

export function articleFallbackHtml(article, locale) {
  const copy = article.locales[locale];
  const body = copy.article ?? fallbackArticle(copy, locale);
  const sectionName =
    article.kind === "focus"
      ? locale === "zh" ? "焦点" : "Focus"
      : locale === "zh" ? "探索" : "Explore";
  const sectionPath = article.kind === "focus" ? "/focus/" : "/explore/";
  return [
    '<main class="article-page article-static-fallback">',
    '  <article class="article-layout">',
    `    <nav class="article-breadcrumb"><a href="${sectionPath}">${escapeHtml(sectionName)}</a> / ${escapeHtml(copy.category)}</nav>`,
    '    <header class="article-hero">',
    `      <p class="article-eyebrow">${escapeHtml(copy.eyebrow)}</p>`,
    `      <h1>${escapeHtml(copy.title)}</h1>`,
    `      <p class="article-dek">${escapeHtml(copy.description)}</p>`,
    '      <p class="article-static-byline">By <a href="/editorial-standards/">All We Need Editorial System</a></p>',
    "    </header>",
    `    <p class="article-lead">${escapeHtml(body.lead)}</p>`,
    ...body.sections.map((section) => [
      '    <section class="article-section">',
      `      <h2>${escapeHtml(section.heading)}</h2>`,
      `      <p>${escapeHtml(section.body)}</p>`,
      "    </section>",
    ].join("\n")),
    '    <section class="article-section">',
    `      <h2>${locale === "zh" ? "接下来关注什么" : "What to watch next"}</h2>`,
    `      <p>${escapeHtml(body.outlook)}</p>`,
    "    </section>",
    '    <section class="article-sources">',
    `      <h2>${locale === "zh" ? "信源" : "Sources"}</h2>`,
    "      <ul>",
    ...copy.evidence.map((evidence) =>
      `        <li><a href="${escapeHtml(evidence.url)}" rel="noopener noreferrer">${escapeHtml(evidence.sourceName)} — ${escapeHtml(evidence.title)}</a></li>`),
    "      </ul>",
    "    </section>",
    "  </article>",
    "</main>",
  ].join("\n");
}

export function applyArticleMetadata(template, article, locale) {
  const copy = article.locales[locale];
  const path = locale === "zh" ? article.zhPath : article.path;
  const canonical = `${siteOrigin}${path}`;
  const language = locale === "zh" ? "zh-CN" : "en";
  const jsonLd = JSON.stringify(articleJsonLd(article, locale)).replaceAll("<", "\\u003c");
  let html = template
    .replace(/<html lang="[^"]*">/, `<html lang="${language}">`)
    .replace(/<title>[\s\S]*?<\/title>/, `<title>${escapeHtml(copy.title)} — All We Need</title>`)
    .replace(
      /<meta\s+name="description"\s+content="[\s\S]*?"\s*\/>/,
      `<meta name="description" content="${escapeHtml(copy.description)}" />`,
    )
    .replace(/<meta property="og:type" content="[^"]*" \/>/, '<meta property="og:type" content="article" />')
    .replace(
      /<meta property="og:title" content="[\s\S]*?" \/>/,
      `<meta property="og:title" content="${escapeHtml(copy.title)}" />`,
    )
    .replace(
      /<meta\s+property="og:description"\s+content="[\s\S]*?"\s*\/>/,
      `<meta property="og:description" content="${escapeHtml(copy.description)}" />`,
    )
    .replace(
      /<link\s+rel="canonical"\s+href="[^"]*"\s*\/>/,
      `<link rel="canonical" href="${canonical}" />`,
    )
    .replace(
      /<meta\s+property="og:url"\s+content="[^"]*"\s*\/>/,
      `<meta property="og:url" content="${canonical}" />`,
    )
    .replace(
      "</head>",
      [
        `    <meta property="article:published_time" content="${article.publishedAt}" />`,
        `    <meta property="article:modified_time" content="${article.updatedAt}" />`,
        '    <meta name="twitter:card" content="summary_large_image" />',
        `    <meta name="twitter:title" content="${escapeHtml(copy.title)}" />`,
        `    <meta name="twitter:description" content="${escapeHtml(copy.description)}" />`,
        `    <meta name="twitter:image" content="${siteOrigin}/og.png" />`,
        `    <link rel="alternate" hreflang="en" href="${siteOrigin}${article.path}" />`,
        `    <link rel="alternate" hreflang="zh-CN" href="${siteOrigin}${article.zhPath}" />`,
        `    <link rel="alternate" hreflang="x-default" href="${siteOrigin}${article.path}" />`,
        `    <script type="application/ld+json">${jsonLd}</script>`,
        "  </head>",
      ].join("\n"),
    );
  html = html.replace(
    '<div id="root"></div>',
    `<div id="root">${articleFallbackHtml(article, locale)}</div>`,
  );
  return html;
}

async function readJson(path, fallback) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return fallback;
    throw error;
  }
}

export async function generateArticleArtifacts(root = projectRoot) {
  const radarPath = resolve(root, "data/daily-radar.json");
  const catalogPath = resolve(root, "data/article-routes.json");
  const radar = await readJson(radarPath, {});
  const previous = await readJson(catalogPath, { articles: [] });
  const catalog = buildArticleCatalog(radar, previous);
  await mkdir(dirname(catalogPath), { recursive: true });
  await writeFile(
    catalogPath,
    `${JSON.stringify(compactArticleCatalog(catalog), null, 2)}\n`,
  );
  await writeFile(resolve(root, "public/sitemap.xml"), renderSitemap(catalog));
  await writeFile(
    resolve(root, "public/news-sitemap.xml"),
    renderNewsSitemap(catalog),
  );
  await writeFile(resolve(root, "public/feed.xml"), renderRssFeed(catalog));
  return catalog;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const catalog = await generateArticleArtifacts();
  console.log(
    `Generated ${catalog.articles.length} permanent article routes.`,
  );
}
