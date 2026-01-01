require("dotenv").config();
const axios = require("axios");
const crypto = require("crypto");
const TelegramBot = require("node-telegram-bot-api");
const sharp = require("sharp");
const http = require("http");

/* =========================
   Render Health Server
   ========================= */
const PORT = process.env.PORT || 3000;
http
  .createServer((req, res) => {
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("OK");
  })
  .listen(PORT, () => console.log("Health server listening on", PORT));

/* =========================
   Telegram
   ========================= */
const token = process.env.TELEGRAM_BOT_TOKEN;
if (!token) throw new Error("Missing TELEGRAM_BOT_TOKEN");
const bot = new TelegramBot(token, { polling: true });

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
  const gateway = process.env.AE_GATEWAY || "https://eco.taobao.com/router/rest";
  const appKey = process.env.AE_APP_KEY;
  const secret = process.env.AE_APP_SECRET;

  if (!appKey || !secret) throw new Error("Missing AE_APP_KEY or AE_APP_SECRET");

  const params = {
    method,
    app_key: appKey,
    timestamp: topTimestamp(),
    format: "json",
    v: "2.0",
    sign_method: "md5",
    ...bizParams,
  };

  params.sign = signTopMd5(params, secret);

  const res = await axios.post(gateway, new URLSearchParams(params), {
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    timeout: 25000,
  });

  return res.data;
}

/* =========================
   AliExpress: product query
   ========================= */
async function affiliateProductQuery(keyword) {
  // sort=LAST_VOLUME_DESC مدعوم رسميًا لفرز أعلى مبيعات :contentReference[oaicite:3]{index=3}
  return topPost("aliexpress.affiliate.product.query", {
    keywords: keyword,
    page_no: 1,
    page_size: 50,
    sort: "LAST_VOLUME_DESC",
    target_language: "AR",
    target_currency: "USD", // ILS غير موجودة في القائمة الرسمية :contentReference[oaicite:4]{index=4}
    ship_to_country: "IL",
    // tracking_id هنا اختياري، لكن مهم جدًا في link.generate
    tracking_id: process.env.TRACKING_ID || "",
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
  return products.map((p) => {
    const title = p?.product_title || "بدون عنوان";

    const priceVal = p?.app_sale_price || p?.sale_price || p?.original_price || "";
    const currency = p?.app_sale_price_currency || p?.sale_price_currency || "USD";

    // أعلى مبيعات: lastest_volume (هكذا مكتوبة في الدوك) :contentReference[oaicite:5]{index=5}
    const ordersNumber = Number(p?.lastest_volume || 0) || 0;

    const rating = p?.evaluate_rate || "—"; // مثال 92.1% :contentReference[oaicite:6]{index=6}

    const image = p?.product_main_image_url || "";
    const detailUrl = p?.product_detail_url || "";

    return {
      title,
      priceVal: String(priceVal),
      currency,
      ordersNumber,
      rating: String(rating),
      image,
      detailUrl,
      affiliateLink: "", // سنملأه من link.generate
    };
  });
}

/* =========================
   AliExpress: link generate
   ========================= */
async function affiliateLinkGenerate(sourceUrls) {
  const trackingId = process.env.TRACKING_ID;
  if (!trackingId) throw new Error("Missing TRACKING_ID (required for affiliate links)");

  // tracking_id + source_values + promotion_link_type إلزامية :contentReference[oaicite:7]{index=7}
  return topPost("aliexpress.affiliate.link.generate", {
    promotion_link_type: 0,
    source_values: sourceUrls.join(","),
    tracking_id: trackingId,
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

function buildCaption(query, items) {
  let msg = `🔥 أفضل 4 منتجات (الأكثر طلبًا) لبحث: ${query}\n\n`;
  items.forEach((p, i) => {
    const link = p.affiliateLink || p.detailUrl || "—";
    msg += `${i + 1}️⃣ ${p.title}\n`;
    msg += `💰 السعر: ${p.currency} ${p.priceVal}\n`;
    msg += `🛒 المبيعات: ${p.ordersNumber}\n`;
    msg += `⭐ التقييم: ${p.rating}\n`;
    msg += `🔗 الرابط: ${link}\n\n`;
  });
  return msg;
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
  // يقبل: "ابحث عن ..." و "ابحث لي عن ..."
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

    // 1) منتجات (مرتبة أصلاً حسب LAST_VOLUME_DESC)
    const productData = await affiliateProductQuery(query);
    const rawProducts = extractProducts(productData);
    let all = normalizeProducts(rawProducts).filter((p) => p.image && p.detailUrl);

    // خذ أول 4 (لأنها أصلاً أعلى مبيعات) + احتياط إذا نقصت
    const topCandidates = all.slice(0, 10);
    if (topCandidates.length < 4) {
      return bot.sendMessage(chatId, "ما لقيت نتائج كافية. جرّب كلمة ثانية 🙂");
    }

    // 2) توليد روابط أفلييت لأفضل 4
    const top4 = topCandidates.slice(0, 4);
    const urls = top4.map((p) => p.detailUrl);

    const linkData = await affiliateLinkGenerate(urls);
    const linksArr = extractPromotionLinks(linkData);

    // map: source_value -> promotion_link
    const linkMap = new Map();
    for (const row of linksArr) {
      if (row?.source_value && row?.promotion_link) {
        linkMap.set(row.source_value, row.promotion_link);
      }
    }
    top4.forEach((p) => {
      p.affiliateLink = linkMap.get(p.detailUrl) || "";
    });

    // 3) كولاج + كابتشن
    const collage = await buildCollage(top4);
    const caption = buildCaption(query, top4);

    await bot.sendPhoto(chatId, collage, { caption });
  } catch (err) {
    console.error(err?.response?.data || err.message);
    bot.sendMessage(
      chatId,
      "صار خطأ 😅\nتأكد أن TRACKING_ID موجود في Render Environment، ثم جرّب مرة ثانية."
    );
  }
});

console.log("Deals48 bot running (polling)...");
