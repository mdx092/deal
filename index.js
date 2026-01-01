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

const AE_GATEWAY = process.env.AE_GATEWAY || "https://api.taobao.com/router/rest";
const AE_APP_KEY = process.env.AE_APP_KEY;
const AE_APP_SECRET = process.env.AE_APP_SECRET;
const TRACKING_ID = process.env.TRACKING_ID;

if (!AE_APP_KEY || !AE_APP_SECRET) throw new Error("Missing AE_APP_KEY or AE_APP_SECRET");
if (!TRACKING_ID) throw new Error("Missing TRACKING_ID");

/**
 * لأن AliExpress Affiliate API لا يدعم ILS كـ target_currency،
 * سنطلب USD ثم نحول لشيكل تقريبًا
 * ضع القيمة في Render → Environment مثل: 3.7 (حسب سعر اليوم)
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
          // فعّل هذا مؤقتًا إذا بدك تتأكد من وصول التحديثات:
          // console.log("Incoming update ✅", update?.update_id);
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

async function topPost(method, bizParams) {
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

  const res = await axios.post(AE_GATEWAY, new URLSearchParams(params), {
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    timeout: 25000,
  });

  return res.data;
}

/* =========================
   AliExpress: Product Query
   ========================= */
async function affiliateProductQuery(keyword) {
  // fields مهم جدًا حتى يضمن يرجّع الصورة + الرابط + السعر + المبيعات
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

  return topPost("aliexpress.affiliate.product.query", {
    keywords: keyword,
    page_no: 1,
    page_size: 50,
    sort: "LAST_VOLUME_DESC",
    fields, // ✅
    target_language: "AR",
    target_currency: "USD",
    ship_to_country: "IL",
    tracking_id: TRACKING_ID,
  });
}

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
    .filter((x) => x.image) // ✅ شرطنا الوحيد الآن: صورة
    .sort((a, b) => b.ordersNumber - a.ordersNumber);
}

/* =========================
   AliExpress: Link Generate
   ========================= */
async function affiliateLinkGenerate(sourceUrls) {
  return topPost("aliexpress.affiliate.link.generate", {
    promotion_link_type: 0,
    source_values: sourceUrls.join(","),
    tracking_id: TRACKING_ID,
  });
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
   Collage (2x2) + numbers
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
  // لو في تحويل، اعرض ₪ + (USD)
  const ils = usdToIls(p.priceVal);
  if (p.currency.toUpperCase() === "USD" && ils !== null) {
    return `₪${ils.toFixed(2)} (USD ${p.priceVal})`;
  }
  // غير ذلك: اعرض العملة كما هي
  return `${p.currency} ${p.priceVal}`;
}

function buildCaption(query, items) {
  let msg = `🔥 أفضل 4 منتجات (الأكثر طلبًا) لبحث: ${query}\n\n`;
  items.forEach((p, i) => {
    const link = p.affiliateLink || p.detailUrl || "—";
    msg += `${i + 1}️⃣ ${p.title}\n`;
    msg += `💰 السعر: ${formatPriceLine(p)}\n`;
    msg += `🛒 المبيعات: ${p.ordersNumber}\n`;
    msg += `⭐ التقييم: ${p.rating}\n`;
    msg += `🔗 الرابط: ${link}\n\n`;
  });
  msg += `🟠 اكتب: "ابحث عن ..."`;
  return msg;
}

/* =========================
   Telegram handlers
   ========================= */
bot.onText(/\/start/, (msg) => {
  bot.sendMessage(
    msg.chat.id,
    "أهلًا 👋\nاكتب مثلًا:\nابحث عن ساعة\nابحث عن شاحن 65W\nابحث لي عن سماعات"
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
  if (!query) return bot.sendMessage(chatId, 'اكتب مثلًا: "ابحث عن سماعات"');

  try {
    bot.sendChatAction(chatId, "upload_photo");

    const productData = await affiliateProductQuery(query);
    const rawProducts = extractProducts(productData);

    const all = normalizeProducts(rawProducts);

    // تشخيص بسيط (يمكنك إلغاءه لاحقًا)
    console.log("rawProducts:", rawProducts.length, "withImage:", all.length);

    if (all.length < 4) {
      return bot.sendMessage(
        chatId,
        "ما لقيت نتائج كافية. جرّب كلمة أبسط مثل: شاحن / سماعات / ساعة (وأحيانًا الإنجليزي يعطي نتائج أكثر). 🙂"
      );
    }

    const top4 = all.slice(0, 4);

    // Generate affiliate links only when we have detailUrl
    const urls = top4.map((p) => p.detailUrl).filter(Boolean);

    if (urls.length) {
      try {
        const linkData = await affiliateLinkGenerate(urls);
        const linksArr = extractPromotionLinks(linkData);

        const linkMap = new Map();
        for (const row of linksArr) {
          if (row?.source_value && row?.promotion_link) {
            linkMap.set(row.source_value, row.promotion_link);
          }
        }

        top4.forEach((p) => {
          p.affiliateLink = p.detailUrl ? (linkMap.get(p.detailUrl) || "") : "";
        });
      } catch (e) {
        console.error("link.generate failed:", e?.response?.data || e.message);
        // نكمل بدون ما نوقف
      }
    }

    const collage = await buildCollage(top4);
    const caption = buildCaption(query, top4);

    await bot.sendPhoto(chatId, collage, { caption });
  } catch (err) {
    console.error(err?.response?.data || err.message);
    bot.sendMessage(
      chatId,
      "صار خطأ 😅\nإذا تكرر، ابعث آخر 20 سطر من Logs (بدون أي أسرار) لنحدد سبب الاستجابة من API."
    );
  }
});

console.log("Deals48 bot running (webhook mode)...");
