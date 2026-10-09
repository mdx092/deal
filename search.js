// منطق البحث (بدون أي تشغيل للبوت) حتى يسهل اختباره.
import crypto from "node:crypto";

const NON_ASCII = /[^\x00-\x7F]/;
const TASHKEEL = /[ؐ-ًؚ-ٰٟـ]/g;

// كلمات لا تدل على المنتج نفسه، فلا تُحسب عند قياس الصلة
const STOPWORDS = new Set([
  "for", "the", "and", "with", "of", "a", "an", "in", "to", "on", "at", "by",
  "from", "new", "hot", "sale", "free", "shipping", "best", "pcs", "pc",
  "من", "في", "مع", "على", "الى", "إلى", "عن", "او", "أو",
]);

// عبارات طلب شائعة في بداية الرسالة ("ابحث لي عن ...") تلوّث الاستعلام
const REQUEST_PREFIX =
  /^\s*(?:(?:من\s*فضلك|لو\s*سمحت)\s+)?(?:ابحث|دور|فتش|شوفلي|ورجيني|اريد|أريد|بدي|ابغى|أبغى|عايز|محتاج|اعطني|أعطني|هات)(?:\s+(?:لي|لى|علي|على|عن|ل))*\s+/u;

export function cleanQuery(text) {
  let q = (text || "").trim().replace(/\s+/g, " ");
  const stripped = q.replace(REQUEST_PREFIX, "").trim();
  if (stripped.length >= 2) q = stripped;
  return q;
}

export function normalize(text) {
  return (text || "")
    .toLowerCase()
    .replace(TASHKEEL, "")
    .replace(/[إأآا]/g, "ا")
    .replace(/ى/g, "ي")
    .replace(/ة/g, "ه");
}

export function stem(token) {
  // العربية: حذف "ال" والجمع السالم "ات" وتاء التأنيث (ة صارت ه بعد التطبيع)، فتتطابق سماعة/سماعات
  if (/^[؀-ۿ]+$/.test(token)) {
    let t = token;
    if (t.length > 4 && t.startsWith("ال")) t = t.slice(2);
    if (t.length > 4 && t.endsWith("ات")) t = t.slice(0, -2);
    else if (t.length > 3 && t.endsWith("ه")) t = t.slice(0, -1);
    return t;
  }
  if (token.length > 4 && token.endsWith("ies")) return token.slice(0, -3) + "y";
  if (token.length > 4 && /(sses|ches|shes|xes)$/.test(token)) return token.slice(0, -2);
  if (token.length > 3 && token.endsWith("s") && !token.endsWith("ss")) return token.slice(0, -1);
  if (token.length > 4 && token.startsWith("ال")) return token.slice(2);
  return token;
}

export function tokens(text) {
  const words = normalize(text).match(/[\p{L}\p{N}_]+/gu) || [];
  const out = [];
  for (const w of words) {
    if (STOPWORDS.has(w)) continue;
    if (w.length < 2 && !/^\d$/.test(w)) continue;
    out.push(stem(w));
  }
  return out;
}

// ---------- ترجمة الاستعلام للإنجليزية (علي إكسبرس أدق مع الإنجليزية) ----------
const translationCache = new Map();

// مزوّدو ترجمة مجانيون. إن حُجب أحدهم (مثل 429 من عناوين Render) ننتقل للتالي ونتجنبه 5 دقائق.
const COOLDOWN_MS = 5 * 60 * 1000;
const blockedUntil = new Map();

async function viaGoogle(t, fetchImpl) {
  const url =
    "https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=en&dt=t&q=" +
    encodeURIComponent(t);
  const res = await fetchImpl(url, { signal: AbortSignal.timeout(5000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  return (data?.[0] || []).map(seg => seg?.[0] || "").join("").trim();
}

// MyMemory لا يدعم الكشف التلقائي للغة، فنحدد العربية أو العبرية من الأحرف
async function viaMyMemory(t, fetchImpl) {
  const lang = /[\u0600-\u06FF]/.test(t) ? "ar" : /[\u0590-\u05FF]/.test(t) ? "he" : null;
  if (!lang) throw new Error("unsupported script");
  const url =
    `https://api.mymemory.translated.net/get?langpair=${lang}|en&q=` + encodeURIComponent(t);
  const res = await fetchImpl(url, { signal: AbortSignal.timeout(5000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  const text = (data?.responseData?.translatedText || "").trim();
  // عند انتهاء الحصة المجانية يرجع نص تحذير بدل الترجمة، فلا نقبله
  if (Number(data?.responseStatus) !== 200 || data?.quotaFinished || /^MYMEMORY WARNING/i.test(text)) {
    throw new Error(`rejected (status ${data?.responseStatus})`);
  }
  return text;
}

const PROVIDERS = [
  ["google", viaGoogle],
  ["mymemory", viaMyMemory],
];

export async function toEnglish(text, fetchImpl = fetch, now = Date.now) {
  const t = (text || "").trim();
  if (!t || !NON_ASCII.test(t)) return t;
  if (translationCache.has(t)) return translationCache.get(t);

  for (const [name, fn] of PROVIDERS) {
    if ((blockedUntil.get(name) || 0) > now()) continue;
    try {
      const translated = await fn(t, fetchImpl);
      if (translated && !NON_ASCII.test(translated)) {
        translationCache.set(t, translated); // لا نخزّن حالات الفشل
        return translated;
      }
      throw new Error("empty or untranslated result");
    } catch (err) {
      console.warn(`translation via ${name} failed: ${err.message}`);
      blockedUntil.set(name, now() + COOLDOWN_MS);
    }
  }
  console.warn("all translation providers failed, using original query");
  return t;
}

// لاختبارات الوحدة فقط
export function _resetTranslationState() {
  translationCache.clear();
  blockedUntil.clear();
}

// ---------- الصلة ----------
function levenshteinRatio(a, b) {
  const m = a.length, n = b.length;
  if (!m && !n) return 1;
  const dp = Array.from({ length: m + 1 }, (_, i) => [i, ...Array(n).fill(0)]);
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = Math.min(
        dp[i - 1][j] + 1,
        dp[i][j - 1] + 1,
        dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)
      );
    }
  }
  return 1 - dp[m][n] / Math.max(m, n);
}

function tokenMatches(q, titleTokens) {
  if (titleTokens.has(q)) return true;
  if (q.length >= 4) {
    for (const t of titleTokens) {
      if (t.length < 4) continue;
      if (t.startsWith(q) || q.startsWith(t)) return true;
      if (levenshteinRatio(q, t) >= 0.8) return true; // أخطاء إملائية بسيطة
    }
  }
  return false;
}

export function relevance(query, title) {
  const qTokens = tokens(query);
  if (!qTokens.length) return { fraction: 1, score: 1 };
  const titleTokens = tokens(title);
  const set = new Set(titleTokens);
  const matched = qTokens.filter(q => tokenMatches(q, set)).length;
  const fraction = matched / qTokens.length;
  let score = fraction;
  if (titleTokens.join(" ").includes(qTokens.join(" "))) score += 0.25;
  return { fraction, score };
}

// يزيل المكرر، يستبعد غير ذي الصلة، ويرتب: الصلة أولًا، ثم المبيعات، ثم ترتيب الواجهة.
// إن لم ينجح أي منتج في الحد الأدنى نرجع أفضل المتاح بدل قائمة فارغة.
export function rankProducts(products, query, { limit = 4, minFraction = 0.6 } = {}) {
  if (!tokens(query).length) return products.slice(0, limit);

  const seenIds = new Set();
  const seenTitles = new Set();
  const scored = [];
  products.forEach((p, pos) => {
    const id = p.id != null ? String(p.id) : "";
    const titleKey = normalize(p.title || "").slice(0, 60);
    if ((id && seenIds.has(id)) || seenTitles.has(titleKey)) return;
    seenIds.add(id);
    seenTitles.add(titleKey);
    const { fraction, score } = relevance(query, p.title || "");
    scored.push({ p, pos, fraction, score, volume: Number(p.sales) || 0 });
  });

  const good = scored.filter(s => s.fraction >= minFraction);
  const pool = good.length ? good : scored;
  pool.sort((a, b) => b.score - a.score || b.volume - a.volume || a.pos - b.pos);
  return pool.slice(0, limit).map(s => s.p);
}

// ---------- واجهة علي إكسبرس الرسمية (Affiliate) ----------
export function createSign(params, secret) {
  const sorted = Object.keys(params)
    .sort()
    .map(k => `${k}${params[k]}`)
    .join("");
  return crypto.createHash("md5").update(secret + sorted + secret, "utf8").digest("hex").toUpperCase();
}

// بوابة taobao القديمة تريد توقيتًا نصيًا (GMT+8)، وبوابة /sync تقبل ميلي ثانية
function timestampFor(gateway, now = Date.now()) {
  if (!/taobao\.com/.test(gateway)) return String(now);
  const d = new Date(now + 8 * 3600 * 1000);
  const p = n => String(n).padStart(2, "0");
  return (
    `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ` +
    `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}`
  );
}

export const BASE_FIELDS =
  "product_id,product_title,product_main_image_url,product_detail_url,sale_price";
export const EXTENDED_FIELDS =
  BASE_FIELDS +
  ",promotion_link,original_price,discount,evaluate_rate,lastest_volume,sale_price_currency" +
  ",target_sale_price,target_sale_price_currency";

export function buildRequest(keyword, cfg, fields = EXTENDED_FIELDS, now = Date.now()) {
  const params = {
    app_key: cfg.appKey,
    method: "aliexpress.affiliate.product.query",
    timestamp: timestampFor(cfg.gateway, now),
    sign_method: "md5",
    format: "json",
    v: "2.0",
    keywords: keyword, // الاسم الصحيح (بالجمع)؛ "keyword" يُتجاهل فتأتي نتائج عامة
    fields,
    page_no: "1",
    page_size: String(cfg.fetchSize ?? 50),
    tracking_id: cfg.trackingId,
  };
  if (cfg.shipTo) params.ship_to_country = cfg.shipTo;
  if (cfg.currency) params.target_currency = cfg.currency;
  if (cfg.language) params.target_language = cfg.language;
  params.sign = createSign(params, cfg.appSecret);
  return params;
}

export function extractProducts(data) {
  const resp = data?.aliexpress_affiliate_product_query_response || {};
  const node = resp?.resp_result?.result || resp;
  let items = node?.products?.product || [];
  if (!Array.isArray(items)) items = [items]; // منتج واحد قد يرجع كائنًا لا قائمة
  return items;
}

export function parseItem(item) {
  return {
    id: item.product_id,
    title: item.product_title || "",
    image: item.product_main_image_url,
    // target_* هي الأسعار بعملة الطلب (target_currency)، ونرجع إلى sale_price إن غابت
    price: item.target_sale_price ?? item.sale_price,
    currency:
      (item.target_sale_price != null ? item.target_sale_price_currency : item.sale_price_currency) || "",
    detailUrl: item.product_detail_url,
    originalPrice: item.original_price,
    discount: item.discount,
    rating: item.evaluate_rate,
    sales: item.lastest_volume,
    // promotion_link يحمل tracking_id الخاص بك، لذلك نفضله على الرابط العادي
    url: item.promotion_link || item.product_detail_url,
  };
}

export async function queryAliExpress(keyword, cfg, fields = EXTENDED_FIELDS, fetchImpl = fetch) {
  const params = buildRequest(keyword, cfg, fields);
  // يرجع دائمًا { items, error } حتى نفرّق بين "فشل الاتصال/الصلاحيات" و"لا توجد نتائج"
  let text = "";
  let data;
  try {
    const res = await fetchImpl(cfg.gateway, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded;charset=utf-8" },
      body: new URLSearchParams(params).toString(),
      signal: AbortSignal.timeout(15000),
    });
    text = await res.text();
    data = JSON.parse(text);
  } catch (err) {
    const error = `request failed: ${err.message}${text ? ` | body: ${text.slice(0, 200)}` : ""}`;
    console.error("AliExpress", error);
    return { items: [], error };
  }
  if (data?.error_response) {
    const error = `API error: ${JSON.stringify(data.error_response).slice(0, 300)}`;
    console.error("AliExpress", error);
    return { items: [], error };
  }
  const result = data?.aliexpress_affiliate_product_query_response?.resp_result;
  if (result && result.resp_code !== undefined && Number(result.resp_code) !== 200) {
    const error = `resp_code ${result.resp_code}: ${result.resp_msg || "unknown"}`;
    console.error("AliExpress", error);
    return { items: [], error };
  }
  const items = extractProducts(data);
  if (!items.length) {
    // لا أسرار في هذه الاستجابة: نسجّل جزءًا منها لمعرفة السبب الحقيقي من Logs
    console.warn(`AliExpress returned 0 items for ${JSON.stringify(keyword)}; raw: ${text.slice(0, 400)}`);
  }
  return { items, error: null };
}

export async function searchProducts(userQuery, cfg, deps = {}) {
  const translate = deps.toEnglish || toEnglish;
  const query = deps.queryAliExpress || queryAliExpress;
  const cleaned = cleanQuery(userQuery);
  const keyword = await translate(cleaned);
  console.log(`search: ${JSON.stringify(userQuery)} -> ${JSON.stringify(keyword)}`);

  if (NON_ASCII.test(keyword)) {
    console.warn("translation unavailable; searching with the original (non-English) text");
  }

  let { items, error } = await query(keyword, cfg, EXTENDED_FIELDS);
  // ربما رفضت الواجهة أحد الحقول الموسعة: نجرّب بالحقول الأساسية
  if (!items.length) ({ items, error } = await query(keyword, cfg, BASE_FIELDS));
  if (!items.length) return { products: [], keyword, error };

  const products = items.map(parseItem);
  return { products: rankProducts(products, keyword, { limit: cfg.limit ?? 4 }), keyword, error: null };
}
