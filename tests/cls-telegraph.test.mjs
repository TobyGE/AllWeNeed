import assert from "node:assert/strict";
import test from "node:test";
import {
  clsTelegraphApiUrl,
  isRelevantClsItem,
  parseClsTelegraphPayload,
} from "../scripts/lib/cls-telegraph.mjs";

const source = {
  id: 178,
  name: "实时财经发现源",
  publisher: "实时财经发现源",
};

test("builds the public telegraph endpoint without identity parameters", () => {
  const latest = new URL(clsTelegraphApiUrl());
  assert.equal(latest.hostname, "m.cls.cn");
  assert.equal(latest.pathname, "/nodeapi/telegraphs");
  assert.equal(latest.searchParams.get("refresh_type"), "1");
  assert.equal(latest.searchParams.get("rn"), "20");
  assert.equal(latest.searchParams.has("last_time"), false);

  const older = new URL(clsTelegraphApiUrl(1_785_370_751));
  assert.equal(older.searchParams.get("last_time"), "1785370751");
});

test("keeps Radar-relevant alerts and removes ads or paid teasers", () => {
  assert.equal(
    isRelevantClsItem({
      content: "三星电子第二季度营业利润89.49万亿韩元。",
      status: 1,
    }),
    true,
  );
  assert.equal(
    isRelevantClsItem({
      title: "【九点特供】AI产业机会",
      content: "解锁直达",
      status: 1,
    }),
    false,
  );
  assert.equal(
    isRelevantClsItem({
      content: "日经225指数涨幅扩大至1%。",
      status: 1,
    }),
    false,
  );
  assert.equal(
    isRelevantClsItem({
      content: "KOSPI指数跌1%，三星电子抹去4%的涨幅。",
      status: 1,
    }),
    false,
  );
  assert.equal(
    isRelevantClsItem({
      title: "财联社7月30日早间新闻精选",
      content: "OpenAI发布新模型，三星电子公布财报。",
      status: 1,
    }),
    false,
  );
});

test("turns wire copy into an anonymous discovery-only item", () => {
  const items = parseClsTelegraphPayload(
    {
      error: 0,
      data: {
        roll_data: [
          {
            id: 2440814,
            ctime: 1785370444,
            status: 1,
            level: "B",
            title: "",
            content:
              "财联社7月30日电，三星电子称，芯片业务第二季度营业利润达89.2万亿韩元。",
            shareurl:
              "https://api3.cls.cn/share/article/2440814?app=CailianpressWap",
          },
        ],
      },
    },
    source,
    "2026-07-30T00:20:00.000Z",
  );

  assert.equal(items.length, 1);
  assert.equal(items[0].sourceKind, "Wire");
  assert.equal(items[0].sourceName, "实时财经发现源");
  assert.equal(items[0].discoveryOnly, true);
  assert.equal(items[0].privateSourceId, 2440814);
  assert.equal(items[0].summary.startsWith("财联社"), false);
  assert.match(items[0].summary, /三星电子/);
});
