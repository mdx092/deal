import crypto from "node:crypto";
import test from "node:test";
import assert from "node:assert/strict";
import {
  queryAliExpress, cleanQuery, stem, tokens, relevance, rankProducts, toEnglish,
  createSign, buildRequest, extractProducts, parseItem, searchProducts,
  BASE_FIELDS, EXTENDED_FIELDS,
} from "./search.js";

const P = (id, title, extra = {}) => ({ id, title, ...extra });
const CFG = { appKey: "k", appSecret: "s", trackingId: "t", gateway: "https://api.aliexpress.com/sync", limit: 4 };

test("stem plurals", () => {
  assert.equal(stem("glasses"), "glass");
  assert.equal(stem("cables"), "cable");
  assert.equal(stem("batteries"), "battery");
  assert.equal(stem("glass"), "glass");
});

test("tokens drop stopwords, keep numbers", () => {
  assert.deepEqual(tokens("iPhone 15 case for the new"), ["iphone", "15", "case"]);
});

test("cleanQuery strips Arabic request prefixes", () => {
  assert.equal(cleanQuery("ابحث لي عن شاحن 65W"), "شاحن 65W");
  assert.equal(cleanQuery("بدي ساعة ذكية"), "ساعة ذكية");
  assert.equal(cleanQuery("شاحن سريع"), "شاحن سريع");
  assert.equal(cleanQuery("ابحث"), "ابحث"); // لا نفرغ الاستعلام
});

test("relevant products beat irrelevant ones", () => {
  const items = [
    P(1, "LED Strip Lights RGB 5m"),
    P(2, "Wireless Bluetooth Earphones TWS Headphones"),
    P(3, "Phone Holder Car Mount"),
    P(4, "Bluetooth Wireless Earphone Noise Cancelling"),
  ];
  const ranked = rankProducts(items, "wireless bluetooth earphones");
  assert.deepEqual(ranked.slice(0, 2).map(p => p.id), [2, 4]);
  assert.ok(!ranked.some(p => p.id === 1));
});

test("two-word query needs both words", () => {
  const items = [P(1, "Silicone Case Cover"), P(2, "iPhone 15 Silicone Case")];
  assert.deepEqual(rankProducts(items, "iphone case").map(p => p.id), [2]);
});

test("typos tolerated", () => {
  assert.equal(relevance("blutooth speaker", "Portable Bluetooth Speaker").fraction, 1);
});

test("dedupes by id and title", () => {
  const items = [P(1, "USB C Cable 2m"), P(1, "USB C Cable 2m"), P(2, "usb c cable 2m"), P(3, "USB-C Fast Charging Cable 1m")];
  assert.equal(rankProducts(items, "usb c cable").length, 2);
});

test("ties: higher sales first, then API order", () => {
  const items = [
    P(10, "Smart Watch Men", { sales: "5" }),
    P(11, "Smart Watch Women", { sales: "900" }),
    P(12, "Smart Watch Kids", { sales: "5" }),
  ];
  assert.deepEqual(rankProducts(items, "smart watch").map(p => p.id), [11, 10, 12]);
});

test("fallback when nothing matches", () => {
  const items = [P(1, "Random Thing"), P(2, "Other Item")];
  assert.equal(rankProducts(items, "laptop", { limit: 2 }).length, 2);
});

test("ascii query is not translated (no network)", async () => {
  const fetchImpl = () => { throw new Error("should not be called"); };
  assert.equal(await toEnglish("wireless mouse", fetchImpl), "wireless mouse");
});

test("translation parsing, cache, and failure fallback", async () => {
  let calls = 0;
  const ok = async () => {
    calls++;
    return { ok: true, json: async () => [[["wireless bluetooth ", "x"], ["earphones", "y"]], null, "ar"] };
  };
  assert.equal(await toEnglish("سماعات بلوتوث لاسلكية", ok), "wireless bluetooth earphones");
  assert.equal(await toEnglish("سماعات بلوتوث لاسلكية", ok), "wireless bluetooth earphones");
  assert.equal(calls, 1);
  const bad = async () => { throw new Error("blocked"); };
  assert.equal(await toEnglish("كلمة اخرى", bad), "كلمة اخرى");
});

test("request uses `keywords` (plural), never `keyword`, and is signed", () => {
  const p = buildRequest("usb cable", CFG, EXTENDED_FIELDS, 1700000000000);
  assert.equal(p.keywords, "usb cable");
  assert.ok(!("keyword" in p));
  assert.equal(p.page_size, "50");
  assert.equal(p.timestamp, "1700000000000");
  const { sign, ...rest } = p;
  assert.equal(sign, createSign(rest, "s"));
  assert.match(sign, /^[0-9A-F]{32}$/);
});

test("taobao gateway gets a formatted GMT+8 timestamp", () => {
  const p = buildRequest("x", { ...CFG, gateway: "https://api.taobao.com/router/rest" }, BASE_FIELDS, Date.UTC(2026, 0, 2, 20, 30, 5));
  assert.equal(p.timestamp, "2026-01-03 04:30:05");
});

test("sign is order independent and known value", () => {
  assert.equal(createSign({ b: "2", a: "1" }, "sec"), createSign({ a: "1", b: "2" }, "sec"));
  // الصيغة الرسمية: md5(secret + k1v1k2v2... + secret) بحروف كبيرة
  const expected = crypto.createHash("md5").update("seca1b2sec").digest("hex").toUpperCase();
  assert.equal(createSign({ a: "1", b: "2" }, "sec"), expected);
});

test("extractProducts handles nested, flat and single-object shapes", () => {
  const nested = { aliexpress_affiliate_product_query_response: { resp_result: { result: { products: { product: [{ product_id: 1 }, { product_id: 2 }] } } } } };
  const flat = { aliexpress_affiliate_product_query_response: { products: { product: { product_id: 3 } } } };
  assert.equal(extractProducts(nested).length, 2);
  assert.equal(extractProducts(flat).length, 1);
  assert.equal(extractProducts({ error_response: {} }).length, 0);
  assert.equal(extractProducts(undefined).length, 0);
});

test("parseItem prefers promotion_link", () => {
  assert.equal(parseItem({ promotion_link: "A", product_detail_url: "B" }).url, "A");
  assert.equal(parseItem({ product_detail_url: "B" }).url, "B");
});

test("searchProducts: cleans, translates, ranks, falls back to base fields", async () => {
  const seen = [];
  const items = [
    { product_id: 1, product_title: "LED Strip Lights", sale_price: "3" },
    { product_id: 2, product_title: "65W GaN USB C Fast Charger", sale_price: "9", lastest_volume: "10" },
  ];
  const deps = {
    toEnglish: async q => { seen.push(["translate", q]); return "65W charger"; },
    queryAliExpress: async (kw, _cfg, fields) => {
      seen.push(["query", kw, fields === EXTENDED_FIELDS ? "ext" : "base"]);
      // الموسعة تفشل، الأساسية تنجح
      return fields === EXTENDED_FIELDS ? { items: [], error: "bad field" } : { items, error: null };
    },
  };
  const { products, keyword } = await searchProducts("ابحث لي عن شاحن 65W", CFG, deps);
  assert.deepEqual(seen[0], ["translate", "شاحن 65W"]);
  assert.deepEqual(seen.slice(1).map(s => s[2]), ["ext", "base"]);
  assert.equal(keyword, "65W charger");
  assert.deepEqual(products.map(p => p.id), [2]);
});

// ---------- أنماط الفشل الحقيقية: نريد معرفة السبب لا مجرد "لا نتائج" ----------
const fakeFetch = body => async () => ({ text: async () => (typeof body === "string" ? body : JSON.stringify(body)) });
const quiet = async fn => {
  const { error, warn } = console;
  console.error = console.warn = () => {};
  try { return await fn(); } finally { console.error = error; console.warn = warn; }
};

test("queryAliExpress: error_response is reported as an error", async () => {
  const r = await quiet(() => queryAliExpress("x", CFG, BASE_FIELDS,
    fakeFetch({ error_response: { code: 29, msg: "Invalid app key" } })));
  assert.deepEqual(r.items, []);
  assert.match(r.error, /Invalid app key/);
});

test("queryAliExpress: non-200 resp_code is reported as an error", async () => {
  const r = await quiet(() => queryAliExpress("x", CFG, BASE_FIELDS,
    fakeFetch({ aliexpress_affiliate_product_query_response: { resp_result: { resp_code: 405, resp_msg: "Not authorized" } } })));
  assert.match(r.error, /405.*Not authorized/);
});

test("queryAliExpress: non-JSON body (e.g. HTML error page) is an error", async () => {
  const r = await quiet(() => queryAliExpress("x", CFG, BASE_FIELDS, fakeFetch("<html>Forbidden</html>")));
  assert.match(r.error, /request failed.*Forbidden/);
});

test("queryAliExpress: genuinely empty result has no error", async () => {
  const r = await quiet(() => queryAliExpress("x", CFG, BASE_FIELDS,
    fakeFetch({ aliexpress_affiliate_product_query_response: { resp_result: { resp_code: 200, result: { products: { product: [] } } } } })));
  assert.deepEqual(r, { items: [], error: null });
});

test("queryAliExpress: success returns items", async () => {
  const r = await quiet(() => queryAliExpress("x", CFG, BASE_FIELDS,
    fakeFetch({ aliexpress_affiliate_product_query_response: { resp_result: { resp_code: 200, result: { products: { product: [{ product_id: 1 }] } } } } })));
  assert.equal(r.items.length, 1);
  assert.equal(r.error, null);
});

test("searchProducts surfaces the API error when nothing is found", async () => {
  const deps = { toEnglish: async q => q, queryAliExpress: async () => ({ items: [], error: "API error: bad sign" }) };
  const r = await quiet(() => searchProducts("headphones", CFG, deps));
  assert.deepEqual(r.products, []);
  assert.equal(r.error, "API error: bad sign");
});
