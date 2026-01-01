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

const PUBLIC_URL = process.env.PUBLIC_URL; // مثال: https://deal-jsyn.onrender.com
if (!PUBLIC_URL) throw new Error("Missing PUBLIC_URL");

const AE_APP_KEY = process.env.AE_APP_KEY;
const AE_APP_SECRET = process.env.AE_APP_SECRET;
const TRACKING_ID = process.env.TRACKING_ID;

if (!AE_APP_KEY || !AE_APP_SECRET) throw new Error("Missing AE_APP_KEY or AE_APP_SECRET");
if (!TRACKING_ID) throw new Error("Missing TRACKING_ID");

const DEBUG = String(process.env.DEBUG || "").trim() === "1";

/**
 * تحويل USD -> ILS اختياري (ضع USD_TO_ILS_RATE في Render مثل 3.7)
 */
const USD_TO_ILS_RATE = Number(process.env.USD_TO_ILS_RATE || "0"); // 0 = بدون تحويل

function usdToIls(usdStr) {
  const usd = Number(String(usdStr).replace(/[^\d.]/g, ""));
  if (!Number.isFinite(usd) || usd <= 0) return null;
  if (!USD_TO_ILS_RATE || USD_TO_ILS_RATE <= 0) return null;
  const ils = usd * USD_TO_ILS_RATE;
  return ils;
}

/* =========================
   Telegram: Webhook mode
   ========================= */
const bot = new TelegramBot(token); // no polling
const WEBHOOK_PATH = `/bot${token}`;
const PORT = process.env.PORT || 3000;

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
  // لا تطبع أشياء حساسة حتى لو ظهرت بالخطأ
  const s = JSON.stringify(obj);
  return s
    .replace(/"sign"\s*:\s*"[^"]+"/g, '"sign":"***"')
    .replace(/"app_key"\s*:\s*"[^"]+"/g, '"app_key":"***"')
    .replace(/"appKey"\s*:\s*"[^"]+"/g, '"appKey":"***"')
    .replace(/"secret"\s*:\s*"[^"]+"/g, '"secret":"***"')
    .replace(/"token"\s*:\s*"[^"]+"/g, '"token":"***"')
    .slice(0, 1600);
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
  // جرّب بالترتيب: env -> eco -> api (بدون تكرار)
  const envGw = (process.env.AE_GATEWAY || "").trim();
  const list = [
    envGw,
    "https://eco.taobao.com/router/rest",
    "https://api.taobao.com/router/rest",
  ].filter(Boolean);

  // إزالة التكرار
  return [...new Set(list)];
}

/* =========================
   AliExpress: Product Query + Fallbacks
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
  // بعض الردود تأتي داخل error_response أو داخل resp_result
  const err =
    root?.error_response ||
    root?.errorResponse ||
    root?.resp_result?.error_response ||
    root?.resp_result?.errorResponse ||
    null;

  if (err) return err;

  const maybeMsg =
    root?.resp_result?.error_msg ||
    root?.resp_result?.errorMessage ||
    root?.error_msg ||
    root?.errorMessage ||
    null;

  if (maybeMsg) return { message: maybeMsg };

  return null;
}

function arabicToEnglishHint(q) {
  // تحويل بسيط لكلمات شائعة فقط (بدون ترجمة كاملة)
  const s = q.trim().toLowerCase();

  const map = [
    [/شاحن/g, "charger"],
    [/شواحن/g, "charger"],
    [/كابل/g, "cable"],
    [/وصلة/g, "cable"],
    [/باور\s*بانك/g, "power bank"],
    [/بنك\s*طاقة/g, "power bank"],
    [/ساعة\s*ذكية/g, "smartwatch"],
    [/ساعة/g, "watch"],
    [/سماعات/g, "earbuds"],
    [/سماعة/g, "earbuds"],
    [/بلوتوث/g, "bluetooth"],
    [/لاسلكي/g, "wireless"],
    [/شاحن\s*65w/g, "65w charger"],
    [/65w/g, "65w"],
    [/65\s*واط/g, "65w"],
    [/100w/g, "100w"],
    [/100\s*واط/g, "100w"],
  ];

  let out = s;
  for (const [re, rep] of map) out = out.replace(re, rep);

  // إذا لم يتغير شيء، رجّع null
  if (out === s) return null;
  return out;
}

async function affiliateProductQueryWithFallback(keyword) {
  const gateways = buildGatewayList();

  // fields أحيانًا يسبب 0 على بعض الحسابات، لذلك نجرب معه ثم بدونه
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

  // المحاولة 1: عربي/نص المستخدم كما هو
  attempts.push({ kw: keyword, withFields: true });
  attempts.push({ kw: keyword, withFields: false });

  // المحاولة 2: إنجليزي (إذا كان عربي)
  const en = arabicToEnglishHint(keyword);
  if (en) {
    attempts.push({ kw: en, withFields: true });
    attempts.push({ kw: en, withFields: false });
  }

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
        if (DEBUG) {
          console.log(
            `API TRY -> gw=${gateway.includes("eco") ? "eco" : gateway.includes("api.") ? "api" : "env"} kw="${a.kw}" fields=${a.withFields}`
          );
        }
        data = await topPost(gateway, "aliexpress.affiliate.product.query", biz);
      } catch (e) {
        console.error("API request failed:", e?.message);
        continue;
      }

      const err = getApiErrorSummary(data);
      const products = extractProducts(data);

      if (DEBUG) {
        console.log(
          "API RESP (short):",
          sanitizeForLog({
            gw: gateway,
            kw: a.kw,
            withFields: a.withFields,
            hasError: !!err,
            error: err || undefined,
            productsCount: products.length,
          })
        );
      }

      // لو في خطأ واضح، نكمّل لمحاولة ثانية
      if (err && products.length === 0) continue;

      // لو في منتجات، رجّعها
      if (products.length > 0) return { products, usedKeyword: a.kw, gateway };
    }
  }

  // فشل كل المحاولات
  return { products: [], usedKeyword: keyword, gateway: null };
}

/* =========================
   Normalize + Link Generate
   ========================= */
function normalizeProducts(products) {
  return products
    .map((p) => {
      const title = p?.product_title || p?.title || "بدون عنوان";

      const priceVal =
        p?.app_sale_price ||
        p?.sale_price ||
        p?.original_price ||
        p?.target_app_sale_price ||
        p?.target_sale_price ||
        "";

      const currency =
        p?.app_sale_price_currency ||
        p?.sale_price_currency ||
        p?.original_price_currency ||
        p?.target_app_sale_price_currency ||
        p?.target_sale_price_currency ||
        "USD";

      const ordersNumber = Number(
        p?.lastest_volume ?? p?.last_volume ?? p?.volume ?? p?.sales_count ?? 0
      ) || 0;

      const rating = p?.evaluate_rate || p?.avg_evaluate_rate || p?.rating || "—";

      const image =
        p?.product_main_image_url ||
        p?.product_main_image ||
        p?.product_small_image_urls?.string?.[0] ||
        p?.product_small_image_urls?.[0] ||
        p?.image_url ||
        "";

      const detailUrl = p?.product_detail_url || p?.product_url || p?.url || "";

      return {
        title,
        priceVal: String(priceVal),
        currency: String(currency),
        ordersNumber,
        rating: String(rating),
        image,
        detailUrl,
        affiliateLink: "",
      };
    })
    .filter((x) => x.image) // أهم شرط: صورة
    .sort((a, b) => b.ordersNumber - a.ordersNumber);
}

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
      console.error("link.generate failed on gateway:", e?.message);
    }
  }
  return null;
}

function extractPromotionLinks(apiData) {
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
   Collage
   ========================= */
function numberBadgeSVG(num) {
  return `
  <svg width="120" height="120">
    <circle cx="60" cy="60" r="52" fill="#ff5a2a"/>
    <text x="60" y="78" font-size="64" text-anchor="middle"
          fill="#ffffff" font-family="Arial" font-weight="700">${num}</text>
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
    const buf = await fetchImageBuffer(items[i].image);
    const img = await sharp(buf).resize(HALF, HALF, { fit: "cover" }).toBuffer();

    const left = (i % 2) * HALF;
    const top = i < 2 ? 0 : HALF;

    layers.push({ input: img, left, top });
    layers.push({
      input: Buffer.from(numberBadgeSVG(i + 1)),
      left: left + 20,
      top: top + 20,
    });
  }

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

function formatPriceLine(p) {
  const ils = p.currency.toUpperCase() === "USD" ? usdToIls(p.priceVal) : null;
  if (ils !== null) return `₪${ils.toFixed(2)} (USD ${p.priceVal})`;
  return `${p.currency} ${p.priceVal}`;
}

function buildCaption(query, items, usedKeyword) {
  let msg = `🔥 أفضل 4 منتجات (الأكثر طلبًا) لبحث: ${query}\n`;
  if (usedKeyword && usedKeyword !== query) msg += `🔎 تم البحث أيضًا بـ: ${usedKeyword}\n`;
  msg += `\n`;

  items.forEach((p, i) => {
    const link = p.affiliateLink || p.detailUrl || "—";
    msg += `${i + 1}️⃣ ${p.title}\n`;
    msg += `💰 السعر: ${formatPriceLine(p)}\n`;
    msg += `🛒 المبيعات: ${p.ordersNumber}\n`;
    msg += `⭐ التقييم: ${p.rating}\n`;
    msg += `🔗 الرابط: ${link}\n\n`;
  });

  msg += `🟠 جرّب كلمات بسيطة: شاحن / سماعات / ساعة أو بالإنجليزي (charger, earbuds, smartwatch)`;
  return msg;
}

/* =========================
   Telegram handlers
   ========================= */
bot.onText(/\/start/, (msg) => {
  bot.sendMessage(
    msg.chat.id,
    "أهلًا 👋\nاكتب مثلًا:\nابحث عن شاحن 65W\nابحث عن ساعة ذكية\nابحث لي عن سماعات\n\n(لو النتائج صفر بالعربي، جرّب إنجليزي: charger / earbuds / smartwatch)"
  );
});

function parseQuery(text) {
  return text.replace(/^\s*ابحث(\s+لي)?\s+عن\s+/i, "").trim();
}

bot.on("message", async (msg) => {
  const chatId = msg.chat.id;
  const text = (msg.text || "").trim();
  if (!text || text.startsWith("/")) return;

  const query = parseQuery(text);
  if (!query) return bot.sendMessage(chatId, 'اكتب مثلًا: "ابحث عن شاحن 65W"');

  try {
    bot.sendChatAction(chatId, "upload_photo");

    const { products: rawProducts, usedKeyword, gateway } =
      await affiliateProductQueryWithFallback(query);

    const all = normalizeProducts(rawProducts);

    console.log(
      `rawProducts: ${rawProducts.length} withImage: ${all.length} (gw=${gateway ? (gateway.includes("eco") ? "eco" : gateway.includes("api.") ? "api" : "env") : "none"})`
    );

    if (all.length < 4) {
      return bot.sendMessage(
        chatId,
        "ما لقيت نتائج كافية من API.\nجرّب كلمة أبسط أو إنجليزي مثل: charger / power bank / smartwatch."
      );
    }

    const top4 = all.slice(0, 4);

    // حاول توليد روابط أفلييت فقط لو detailUrl موجود
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
    const caption = buildCaption(query, top4, usedKeyword);

    await bot.sendPhoto(chatId, collage, { caption });
  } catch (err) {
    console.error("BOT ERROR:", err?.response?.data || err.message);
    bot.sendMessage(
      chatId,
      "صار خطأ 😅\nإذا تكرر، فعّل DEBUG=1 في Render وابعت آخر Logs (بدون أسرار)."
    );
  }
});

console.log("Deals48 bot running (webhook mode)...");
