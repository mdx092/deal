require("dotenv").config();

const axios = require("axios");
const crypto = require("crypto");
const sharp = require("sharp");
const http = require("http");
const TelegramBot = require("node-telegram-bot-api");

/* =========================
   ENV
========================= */
const token = process.env.TELEGRAM_BOT_TOKEN;
if (!token) throw new Error("Missing TELEGRAM_BOT_TOKEN");

// Render usually provides this, but keep PUBLIC_URL supported
const PUBLIC_URL = process.env.RENDER_EXTERNAL_URL || process.env.PUBLIC_URL;
if (!PUBLIC_URL) throw new Error("Missing PUBLIC_URL (or RENDER_EXTERNAL_URL)");

const AE_APP_KEY = process.env.AE_APP_KEY;
const AE_APP_SECRET = process.env.AE_APP_SECRET;
const TRACKING_ID = process.env.TRACKING_ID; // AliExpress Affiliate Tracking ID

if (!AE_APP_KEY || !AE_APP_SECRET) throw new Error("Missing AE_APP_KEY or AE_APP_SECRET");
if (!TRACKING_ID) throw new Error("Missing TRACKING_ID");

const DEBUG = String(process.env.DEBUG || "").trim() === "1";

// Optional currency rates (set in Render Env)
const CNY_TO_ILS_RATE = Number(process.env.CNY_TO_ILS_RATE || "0"); // example 0.52
const USD_TO_ILS_RATE = Number(process.env.USD_TO_ILS_RATE || "0"); // example 3.7

/* =========================
   Telegram webhook server
========================= */
const bot = new TelegramBot(token); // webhook mode (no polling)
const WEBHOOK_PATH = `/bot${token}`;
const PORT = Number(process.env.PORT || 10000);

bot.setWebHook(`${PUBLIC_URL}${WEBHOOK_PATH}`);
console.log("Webhook set ✅");

http
  .createServer((req, res) => {
    // health
    if (req.method === "GET" && req.url === "/") {
      res.writeHead(200, { "Content-Type": "text/plain" });
      return res.end("OK");
    }

    // webhook updates
    if (req.method === "POST" && req.url === WEBHOOK_PATH) {
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", () => {
        try {
          const update = JSON.parse(body);
          if (DEBUG) console.log("Incoming update ✅", update?.update_id);
          bot.processUpdate(update);
        } catch (e) {
          console.error("Bad JSON update:", e.message);
        }
        res.writeHead(200);
        res.end("OK");
      });
      return;
    }

    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("Not found");
  })
  .listen(PORT, () => console.log("Server listening on", PORT));

/* =========================
   TOP helpers
========================= */
function topTimestamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(
    d.getHours()
  )}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function signTopMd5(params, secret) {
  const keys = Object.keys(params).sort();
  let base = secret;
  for (const k of keys) {
    const v = params[k];
    if (v !== undefined && v !== null && v !== "") base += `${k}${v}`;
  }
  base += secret;
  return crypto.createHash("md5").update(base, "utf8").digest("hex").toUpperCase();
}

function sanitizeForLog(obj) {
  const s = typeof obj === "string" ? obj : JSON.stringify(obj);
  return s
    .replace(/"sign"\s*:\s*"[^"]+"/g, '"sign":"***"')
    .replace(/"app_key"\s*:\s*"[^"]+"/g, '"app_key":"***"')
    .replace(/"token"\s*:\s*"[^"]+"/g, '"token":"***"')
    .slice(0, 1800);
}

async function topPost(gateway, method, bizParams) {
  const params = {
    method,
    app_key: AE_APP_KEY,
    timestamp: topTimestamp(),
    format: "json",
    v: "2.0",
    sign_method: "md5",
    ...bizParams,
  };
  params.sign = signTopMd5(params, AE_APP_SECRET);

  const res = await axios.post(gateway, new URLSearchParams(params), {
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    timeout: 25000,
  });

  return res.data;
}

/* =========================
   Gateways fallback
========================= */
function buildGatewayList() {
  const envGw = (process.env.AE_GATEWAY || "").trim();
  const list = [
    envGw,
    "https://eco.taobao.com/router/rest",
    "https://api.taobao.com/router/rest",
  ].filter(Boolean);

  return [...new Set(list)];
}

function gwLabel(gw) {
  if (!gw) return "none";
  if (gw.includes("eco.taobao.com")) return "eco";
  if (gw.includes("api.taobao.com")) return "api";
  return "env";
}

/* =========================
   Response extract
========================= */
function extractProducts(apiData) {
  const root =
    apiData?.aliexpress_affiliate_product_query_response ||
    apiData?.aliexpress_affiliate_product_query_resp ||
    apiData;

  const products =
    root?.resp_result?.result?.products?.product ||
    root?.resp_result?.result?.products ||
    root?.result?.products?.product ||
    root?.result?.products ||
    [];

  return Array.isArray(products) ? products : [];
}

function getApiErrorSummary(apiData) {
  const root = apiData || {};
  const err =
    root?.error_response ||
    root?.errorResponse ||
    root?.resp_result?.error_response ||
    root?.resp_result?.errorResponse ||
    null;
  if (err) return err;

  const msg =
    root?.resp_result?.error_msg ||
    root?.resp_result?.errorMessage ||
    root?.error_msg ||
    root?.errorMessage ||
    root?.msg ||
    null;

  if (msg) return { message: msg };
  return null;
}

/* =========================
   Keyword helper (optional)
========================= */
function arabicToEnglishHint(q) {
  const s = q.trim().toLowerCase();
  const map = [
    [/شاحن\s*65w/g, "65w charger"],
    [/65\s*واط/g, "65w"],
    [/100\s*واط/g, "100w"],
    [/شاحن/g, "charger"],
    [/كابل/g, "cable"],
    [/باور\s*بانك/g, "power bank"],
    [/بنك\s*طاقة/g, "power bank"],
    [/ساعة\s*ذكية/g, "smartwatch"],
    [/ساعة/g, "watch"],
    [/سماعات/g, "earbuds"],
    [/بلوتوث/g, "bluetooth"],
    [/لاسلكي/g, "wireless"],
  ];
  let out = s;
  for (const [re, rep] of map) out = out.replace(re, rep);
  if (out === s) return null;
  return out;
}

/* =========================
   Query with fallback
========================= */
async function affiliateProductQueryWithFallback(keyword) {
  const gateways = buildGatewayList();

  const fields = [
    "product_title",
    "product_main_image_url",
    "product_detail_url",
    "app_sale_price",
    "app_sale_price_currency",
    "sale_price",
    "sale_price_currency",
    "original_price",
    "original_price_currency",
    "lastest_volume",
    "evaluate_rate",
  ].join(",");

  const attempts = [];
  attempts.push({ kw: keyword, withFields: true });
  attempts.push({ kw: keyword, withFields: false });

  const en = arabicToEnglishHint(keyword);
  if (en) {
    attempts.push({ kw: en, withFields: true });
    attempts.push({ kw: en, withFields: false });
  }

  let lastInfo = null;

  for (const gateway of gateways) {
    for (const a of attempts) {
      const biz = {
        keywords: a.kw,
        page_no: 1,
        page_size: 50,
        sort: "LAST_VOLUME_DESC",
        target_language: "AR",
        target_currency: "USD",
        ship_to_country: "IL",
        tracking_id: TRACKING_ID,
      };
      if (a.withFields) biz.fields = fields;

      let data;
      try {
        if (DEBUG) console.log(`API TRY -> gw=${gwLabel(gateway)} kw="${a.kw}" fields=${a.withFields}`);
        data = await topPost(gateway, "aliexpress.affiliate.product.query", biz);
      } catch (e) {
        lastInfo = { gw: gwLabel(gateway), kw: a.kw, withFields: a.withFields, networkError: e?.message };
        console.log("API NET ERR:", sanitizeForLog(lastInfo));
        continue;
      }

      const err = getApiErrorSummary(data);
      const products = extractProducts(data);

      lastInfo = {
        gw: gwLabel(gateway),
        kw: a.kw,
        withFields: a.withFields,
        productsCount: products.length,
        hasError: !!err,
        error: err || null,
      };

      if (DEBUG) console.log("API RESP (short):", sanitizeForLog(lastInfo));

      if (products.length > 0) return { products, usedKeyword: a.kw, gateway };
    }
  }

  if (DEBUG) console.log("API FINAL FAIL:", sanitizeForLog(lastInfo || { note: "no_attempts" }));
  return { products: [], usedKeyword: keyword, gateway: null };
}

/* =========================
   Title shortener
========================= */
function cleanTitle(title, maxLen = 60) {
  if (!title) return "منتج";
  let t = String(title);

  t = t
    .replace(/[™®©]/g, "")
    .replace(/\s+/g, " ")
    .replace(/\b(Hot|New|Best|Sale|Original|202\d|Free\s*Shipping|Shipping|Discount|Top)\b/gi, "")
    .replace(/\b(For|With|And|Or|The|A|An)\b/gi, "")
    .replace(/\b(حار|جديد|الأفضل|تخفيض|عرض|أصلي|شحن\s*مجاني|توصيل|خصم)\b/gi, "")
    .trim();

  if (t.length > maxLen) t = t.slice(0, maxLen - 1).trim() + "…";
  return t || "منتج";
}

/* =========================
   Currency + rating
========================= */
function numFromAny(x) {
  if (x === null || x === undefined) return null;
  const m = String(x).match(/(\d+(\.\d+)?)/);
  return m ? Number(m[1]) : null;
}

function priceToILS(priceNum, currency) {
  if (!Number.isFinite(priceNum)) return null;
  const cur = String(currency || "").toUpperCase();

  if (cur === "ILS") return priceNum;
  if (cur === "CNY" && CNY_TO_ILS_RATE > 0) return priceNum * CNY_TO_ILS_RATE;
  if (cur === "USD" && USD_TO_ILS_RATE > 0) return priceNum * USD_TO_ILS_RATE;

  return null;
}

function formatPriceILS(priceNum, currency) {
  const ils = priceToILS(priceNum, currency);
  if (ils !== null) return `₪${ils.toFixed(2)}`;
  if (priceNum === null || priceNum === undefined) return "—";
  return `${currency || ""} ${priceNum}`;
}

function ratingTo5(raw) {
  const n = numFromAny(raw);
  if (!Number.isFinite(n)) return null;

  // if percent 0..100
  if (n > 5 && n <= 100) return Math.round((n / 20) * 10) / 10;

  // already 0..5
  if (n >= 0 && n <= 5) return Math.round(n * 10) / 10;

  return null;
}

/* =========================
   Relevance score (simple)
========================= */
function relevanceScore(query, title) {
  const q = String(query || "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .filter((w) => w.length >= 2);

  const t = String(title || "").toLowerCase();

  let score = 0;
  for (const w of new Set(q)) {
    if (t.includes(w)) score += 2;
  }
  if (q.length && t.includes(q[0])) score += 3;
  return score;
}

/* =========================
   Normalize products
========================= */
function normalizeProducts(rawProducts, query) {
  return rawProducts
    .map((p) => {
      const title = p?.product_title || p?.title || "منتج";
      const shortTitle = cleanTitle(title, 60);

      const image =
        p?.product_main_image_url ||
        p?.product_main_image ||
        p?.product_small_image_urls?.string?.[0] ||
        p?.product_small_image_urls?.[0] ||
        p?.image_url ||
        "";

      const detailUrl = p?.product_detail_url || p?.product_url || p?.url || "";

      const priceRaw =
        p?.app_sale_price ||
        p?.sale_price ||
        p?.original_price ||
        p?.target_app_sale_price ||
        p?.target_sale_price ||
        "";

      const priceNum = numFromAny(priceRaw);

      const currency =
        p?.app_sale_price_currency ||
        p?.sale_price_currency ||
        p?.original_price_currency ||
        p?.target_app_sale_price_currency ||
        p?.target_sale_price_currency ||
        (String(priceRaw).includes("US") ? "USD" : "CNY");

      const orders = Number(p?.lastest_volume ?? p?.last_volume ?? p?.volume ?? p?.sales_count ?? 0) || 0;

      const ratingRaw = p?.evaluate_rate || p?.avg_evaluate_rate || p?.rating || null;
      const rating5 = ratingTo5(ratingRaw);

      const rel = relevanceScore(query, title);

      return {
        title,
        shortTitle,
        image,
        detailUrl,
        priceNum,
        currency,
        orders,
        rating5,
        rel,
        affiliateLink: "",
      };
    })
    .filter((x) => x.image && x.detailUrl);
}

/* =========================
   Affiliate link generate
========================= */
async function affiliateLinkGenerate(sourceUrls) {
  const gateways = buildGatewayList();
  for (const gateway of gateways) {
    try {
      const data = await topPost(gateway, "aliexpress.affiliate.link.generate", {
        promotion_link_type: 0,
        source_values: sourceUrls.join(","),
        tracking_id: TRACKING_ID,
      });
      return data;
    } catch (e) {
      console.error("link.generate failed:", gwLabel(gateway), e?.message);
    }
  }
  return null;
}

function extractPromotionLinks(apiData) {
  if (!apiData) return [];
  const root =
    apiData?.aliexpress_affiliate_link_generate_response ||
    apiData?.aliexpress_affiliate_link_generate_resp ||
    apiData;

  const arr =
    root?.resp_result?.result?.promotion_links?.promotion_link ||
    root?.result?.promotion_links?.promotion_link ||
    [];

  return Array.isArray(arr) ? arr : [];
}

/* =========================
   Collage 2x2 (NO TEXT) + smaller numbers
========================= */
function numberBadgeSVG(num) {
  // أصغر من قبل
  return `
  <svg width="90" height="90">
    <circle cx="45" cy="45" r="38" fill="#ff5a2a"/>
    <text x="45" y="60" font-size="46" text-anchor="middle"
          fill="#ffffff" font-family="Arial" font-weight="800">${num}</text>
  </svg>`;
}

async function fetchImageBuffer(url) {
  const res = await axios.get(url, { responseType: "arraybuffer", timeout: 25000 });
  return Buffer.from(res.data);
}

async function buildCollage(items) {
  const SIZE = 1000;
  const HALF = SIZE / 2;

  const base = sharp({
    create: {
      width: SIZE,
      height: SIZE,
      channels: 3,
      background: { r: 255, g: 255, b: 255 },
    },
  });

  const layers = [];

  for (let i = 0; i < 4; i++) {
    const left = (i % 2) * HALF;
    const top = i < 2 ? 0 : HALF;

    const buf = await fetchImageBuffer(items[i].image);

    const img = await sharp(buf)
      .resize(HALF, HALF, { fit: "cover" })
      .toBuffer();

    layers.push({ input: img, left, top });

    // رقم أصغر + مكانه شوي أقرب
    layers.push({
      input: Buffer.from(numberBadgeSVG(i + 1)),
      left: left + 14,
      top: top + 14,
    });
  }

  // خطوط فصل خفيفة
  layers.push({
    input: Buffer.from(`
      <svg width="${SIZE}" height="${SIZE}">
        <rect x="${HALF - 2}" y="0" width="4" height="${SIZE}" fill="#ffffff" opacity="0.95"/>
        <rect x="0" y="${HALF - 2}" width="${SIZE}" height="4" fill="#ffffff" opacity="0.95"/>
      </svg>
    `),
    left: 0,
    top: 0,
  });

  return base.composite(layers).jpeg({ quality: 85 }).toBuffer();
}

/* =========================
   Caption builder
========================= */
function buildCaption(query, items) {
  let msg = `🔥 أفضل 4 منتجات (الأكثر طلبًا)\n`;
  msg += `🔎 البحث: ${query}\n\n`;

  items.forEach((p, i) => {
    const link = p.affiliateLink || p.detailUrl || "—";
    const priceText = formatPriceILS(p.priceNum, p.currency);
    const ratingText = p.rating5 ? `${p.rating5}/5` : "—";

    msg += `${i + 1}️⃣ ${p.shortTitle}\n`;
    msg += `💰 السعر: ${priceText}\n`;
    msg += `🛒 المبيعات: ${p.orders}\n`;
    msg += `⭐ التقييم: ${ratingText}\n`;
    msg += `🔗 الرابط: ${link}\n\n`;
  });

  return msg.trim();
}

/* =========================
   Telegram handlers
========================= */
bot.onText(/\/start/, (msg) => {
  bot.sendMessage(
    msg.chat.id,
    "أهلًا 👋\nاكتب مثلًا:\nابحث عن ساعة ذكية\nابحث لي عن شاحن 65W"
  );
});

function parseQuery(text) {
  const t = (text || "").trim();
  // supports: ابحث عن / ابحث لي عن / ابحث
  const cleaned = t
    .replace(/^\s*ابحث(\s+لي)?\s+عن\s+/i, "")
    .replace(/^\s*ابحث\s+/i, "")
    .trim();
  return cleaned || t;
}

bot.on("message", async (msg) => {
  const chatId = msg.chat.id;
  const text = (msg.text || "").trim();
  if (!text || text.startsWith("/")) return;

  const query = parseQuery(text);
  if (!query) return bot.sendMessage(chatId, 'اكتب مثلًا: "ابحث عن شاحن 65W"');

  try {
    bot.sendChatAction(chatId, "upload_photo");

    const { products: rawProducts, gateway } = await affiliateProductQueryWithFallback(query);

    const normAll = normalizeProducts(rawProducts, query);

    // فلترة صلة (لو ما كفت، نخفف)
    let candidates = normAll.filter((p) => p.rel >= 2);
    if (candidates.length < 4) candidates = normAll;

    // ترتيب: صلة ثم مبيعات
    candidates.sort((a, b) => (b.rel - a.rel) || (b.orders - a.orders));

    // خذ 4
    const top4 = candidates.slice(0, 4);

    console.log(
      `rawProducts: ${rawProducts.length} normalized: ${normAll.length} top4: ${top4.length} (gw=${gwLabel(gateway)})`
    );

    if (top4.length < 4) {
      return bot.sendMessage(chatId, "ما لقيت 4 نتائج مناسبة. جرّب كلمة ثانية 🙂");
    }

    // Affiliate links
    const urls = top4.map((p) => p.detailUrl).filter(Boolean);
    if (urls.length) {
      const linkData = await affiliateLinkGenerate(urls);
      if (linkData) {
        const linksArr = extractPromotionLinks(linkData);
        const linkMap = new Map();
        for (const row of linksArr) {
          if (row?.source_value && row?.promotion_link) linkMap.set(row.source_value, row.promotion_link);
        }
        top4.forEach((p) => {
          p.affiliateLink = p.detailUrl ? (linkMap.get(p.detailUrl) || "") : "";
        });
      }
    }

    const collage = await buildCollage(top4);
    const caption = buildCaption(query, top4);

    await bot.sendPhoto(chatId, collage, { caption });
  } catch (err) {
    console.error("BOT ERROR:", sanitizeForLog(err?.response?.data || err.message));
    bot.sendMessage(chatId, "صار خطأ 😅 جرّب مرة ثانية.");
  }
});

console.log("Deals48 bot running (webhook mode)...");
