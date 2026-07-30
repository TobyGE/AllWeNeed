const excludedPatterns =
  /VIP资讯|解锁直达|点金互动易|九点特供|研选[·•]研报|风口研报|电报解读|早间新闻精选|午间新闻精选|晚间新闻精选/iu;

const radarTerms = [
  "ai",
  "agent",
  "openai",
  "anthropic",
  "nvidia",
  "meta",
  "microsoft",
  "google",
  "alphabet",
  "amazon",
  "apple",
  "tesla",
  "amd",
  "tsmc",
  "asml",
  "samsung",
  "xai",
  "人工智能",
  "大模型",
  "模型",
  "智能体",
  "机器人",
  "芯片",
  "半导体",
  "算力",
  "数据中心",
  "云业务",
  "财报",
  "营收",
  "销售额",
  "净利润",
  "营业利润",
  "经营利润",
  "业绩",
  "指引",
  "融资",
  "收购",
  "并购",
  "ipo",
  "美联储",
  "fomc",
  "利率",
  "监管",
  "反垄断",
  "网络安全",
  "漏洞",
  "英伟达",
  "微软",
  "亚马逊",
  "苹果",
  "特斯拉",
  "台积电",
  "三星",
];

const hardSignalTerms =
  /财报|营收|销售额|净利润|营业利润|经营利润|业绩|指引|融资|收购|并购|ipo|发布|宣布|推出|签署|订单|监管|反垄断|利率|fomc|美联储|人工智能|大模型|智能体|agent|芯片|半导体|算力|数据中心|网络安全|漏洞/iu;

const marketTickPattern =
  /(?:指数|期货|股价|股票|etf).{0,20}(?:涨|跌|开盘|收盘)|(?:涨幅|跌幅).{0,20}(?:扩大|收窄|达到|至)|(?:涨|跌)(?:超|近)?\s*\d+(?:\.\d+)?%/iu;

function cleanText(value = "") {
  return String(value)
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function anonymousClaim(value = "") {
  return cleanText(value)
    .replace(/^(?:【[^】]+】)?财联社\d{1,2}月\d{1,2}日电[，,]?\s*/u, "")
    .trim();
}

export function isRelevantClsItem(item) {
  if (
    !item ||
    item.status === 0 ||
    item.is_ad ||
    item.is_fad ||
    excludedPatterns.test(`${item.title ?? ""} ${item.content ?? ""}`)
  ) {
    return false;
  }
  const text = `${item.title ?? ""} ${item.content ?? ""}`.toLowerCase();
  if (marketTickPattern.test(text) && !hardSignalTerms.test(text)) return false;
  return radarTerms.some((term) => text.includes(term));
}

export function clsTelegraphApiUrl(lastTime) {
  const url = new URL("https://m.cls.cn/nodeapi/telegraphs");
  url.searchParams.set("refresh_type", "1");
  url.searchParams.set("rn", "20");
  if (Number.isFinite(lastTime) && lastTime > 0) {
    url.searchParams.set("last_time", String(Math.trunc(lastTime)));
  }
  return url.toString();
}

export function rawClsItems(payload) {
  if (
    !payload ||
    ![0, undefined].includes(payload.error) ||
    !Array.isArray(payload.data?.roll_data)
  ) {
    throw new Error("财联社公开端点未返回有效 roll_data");
  }
  return payload.data.roll_data;
}

export function parseClsTelegraphPayload(payload, source, checkedAt) {
  return rawClsItems(payload)
    .filter(isRelevantClsItem)
    .flatMap((item) => {
      const claim = anonymousClaim(item.content || item.brief || item.title);
      const title = anonymousClaim(item.title) || claim.slice(0, 120);
      const numericId = Number(item.id);
      const timestamp = Number(item.ctime);
      if (!Number.isFinite(numericId) || !claim) return [];
      const publishedAt = Number.isFinite(timestamp)
        ? new Date(timestamp * 1_000).toISOString()
        : null;
      const url =
        cleanText(item.shareurl) ||
        `https://api3.cls.cn/share/article/${numericId}?app=CailianpressWap`;

      return [
        {
          id: `${source.id}-wire-${numericId}`,
          sourceId: source.id,
          sourceName: source.name,
          sourcePublisher: source.publisher ?? source.name,
          sourceKind: "Wire",
          title,
          url,
          publishedAt,
          summary: claim.slice(0, 900),
          fetchedAt: checkedAt,
          discoveryOnly: true,
          privateSourceId: numericId,
          discoveryLevel: cleanText(item.level) || "C",
        },
      ];
    });
}
