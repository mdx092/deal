require("dotenv").config();
const axios = require("axios");
const crypto = require("crypto");
const TelegramBot = require("node-telegram-bot-api");
const sharp = require("sharp");

/* =========================================================
   Render Health Server (Required for Web Service Port Binding)
   ========================================================= */
const http = require("http");
const PORT = process.env.PORT || 3000;

http
  .createServer((req, res) => {
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("OK");
  })
  .listen(PORT, () => console.log("Health server listening on", PORT));

/* =========================================================
   Telegram
   ========================================================= */
const token = process.env.TELEGRAM_BOT_TOKEN;
if (!token) throw new Error("Missing TELEGRAM_BOT_TOKEN");
const bot = new TelegramBot(token, { polling: true });

/* =========================================================
   TOP / AliExpress Official Affiliate API helpers
   method: aliexpress.affiliate.product.query
   ========================================================= */
function topTimestamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(
    d.getHours()
  )}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function signTop(params, secret) {
  const keys = Object.keys(params).sort();
  let base = secret;

  for (const k of keys) {
    const v = params[k];
    if (v !== undefined && v !== null && v !== "") base += `${k}${v}`;
  }

  base += secret;
  return crypto.createHash("md5").update(base, "utf8").digest("hex").toUpperCase();
}

async function affiliateProductQuery(keyword) {
  const gateway = process.env.AE_GATEWAY || "https://api.taobao.com/router/rest";
  const appKey = process.env.AE_APP_KEY;
  const secret = process.env.AE_APP_SECRET;

  if (!appKey || !secret) throw new Error("Missing AE_APP_KEY or AE_APP_SECRET");

  const params = {
    method: "aliexpress.affiliate.product.query",
    app_key: appKey,
    timestamp: topTimestamp(),
    format: "json",
    v: "2.0",
    sign_method: "md5",

    keywords: keyword,
    page_no: 1,
    page_size: 50, // نجلب أكثر ثم نفلتر أعلى مبيعات

    target_language: "AR",
    target_currency: "ILS", // ₪
    ship_to_country: "IL",

    tracking_id: process.env.TRACKING_ID || "",
  };

  params.sign = signTop(params, secret);

  const res = await axios.post(gateway, new URLSearchParams(params), {
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    timeout: 25000,
  });

  return res.data;
}

function extractProducts(apiData) {
  const root =
    apiData?.aliexpress_affiliate_product_query_response ||
    apiData?.aliexpress_affiliate_product_query_resp ||
    apiData?.response ||
    apiData;

  const products =
    root?.result?.products?.product ||
    root?.result?.products ||
    root?.result?.product ||
    root?.products?.product ||
    root?.products ||
    [];

  return Array.isArray(products) ? products : [];
}

/* =========================================================
   Orders parsing + normalize
   ========================================================= */
function parseOrdersToNumber(v) {
  if (v === undefined || v === null) return 0;

  let s = String(v).trim().toUpperCase();
  s = s.replace(/\+/g, "").replace(/\s+/g, "");

  // 1,234 | 12K | 1.2K | 3M
  const m = s.match(/^([\d.,]+)([KM])?$/);
  if (!m) {
    const only = s.replace(/,/g, "").replace(/[^\d.]/g, "");
    const n = Number(only);
    return Number.isFinite(n) ? Math.floor(n) : 0;
  }

  let num = Number(m[1].replace(/,/g, ""));
  if (!Number.isFinite(num)) num = 0;

  const suffix = m[2];
  if (suffix === "K") num *= 1000;
  if (suffix === "M") num *= 1000000;

  return Math.floor(num);
}

function normalizeProducts(products) {
  return products.map((p) => {
    const title = p?.product_title || p?.title || p?.productTitle || "بدون عنوان";

    const priceVal =
      p?.target_app_sale_price ||
      p?.target_sale_price ||
      p?.target_original_price ||
      p?.sale_price ||
      p?.app_sale_price ||
      "";

    const price = priceVal ? `₪${String(priceVal).replace(/[^\d.]/g, "")}` : "—";

    // حاول أكثر من حقل للمبيعات/الطلبات
    const ordersRaw =
      p?.sales_count ??
      p?.volume ??
      p?.orders ??
      p?.trade_count ??
      p?.order_count ??
      p?.sold ??
      0;

    const ordersNumber = parseOrdersToNumber(ordersRaw);

    // التقييم (قد يختلف حسب الاستجابة)
    const rating = p?.evaluate_rate ?? p?.avg_evaluate_rate ?? p?.rating ?? "—";

    const image =
      p?.product_main_image_url ||
      p?.product_main_image ||
      p?.image_url ||
      p?.main_image_url ||
      p?.product_image ||
      "";

    const link =
      p?.promotion_link ||
      p?.promotionLink ||
      p?.product_detail_url ||
      p?.product_url ||
      p?.url ||
      "";

    return {
      title,
      price,
      ordersRaw: String(ordersRaw ?? "—"),
      ordersNumber,
      rating: String(rating ?? "—"),
      image,
      link,
    };
  });
}

/* =========================================================
   Collage builder (2x2 + numbered badges)
   ========================================================= */
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

  // separators (white lines)
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

function buildArabicCaption(query, items) {
  let msg = `🔥 أفضل 4 منتجات (الأكثر طلبًا) لبحث: ${query}\n\n`;
  items.forEach((p, i) => {
    msg += `${i + 1}️⃣ ${p.title}\n`;
    msg += `💰 السعر: ${p.price}\n`;
    msg += `🛒 المبيعات: ${p.ordersRaw}\n`;
    msg += `⭐ التقييم: ${p.rating}\n`;
    msg += `🔗 الرابط: ${p.link}\n\n`;
  });
  msg += `🟠 اكتب: "ابحث لي عن ..."`;
  return msg;
}

/* =========================================================
   Telegram handlers
   ========================================================= */
bot.onText(/\/start/, (msg) => {
  bot.sendMessage(
    msg.chat.id,
    "أهلًا 👋\nاكتب مثلًا:\nابحث لي عن ساعة ذكية\nابحث لي عن شاحن 65W"
  );
});

bot.on("message", async (msg) => {
  const chatId = msg.chat.id;
  const text = (msg.text || "").trim();

  if (!text || text.startsWith("/")) return;

  const query = text.replace(/^ابحث\s*لي\s*عن\s*/i, "").trim();
  if (!query) return bot.sendMessage(chatId, 'اكتب مثلًا: "ابحث لي عن سماعات"');

  try {
    bot.sendChatAction(chatId, "upload_photo");

    const apiData = await affiliateProductQuery(query);
    const rawProducts = extractProducts(apiData);

    let all = normalizeProducts(rawProducts).filter((p) => p.link && p.image);

    // sort by orders desc and take top 4
    all.sort((a, b) => b.ordersNumber - a.ordersNumber);
    const top4 = all.slice(0, 4);

    if (top4.length < 4) {
      return bot.sendMessage(chatId, "ما لقيت 4 نتائج مناسبة. جرّب كلمة ثانية 🙂");
    }

    const collage = await buildCollage(top4);
    const caption = buildArabicCaption(query, top4);

    await bot.sendPhoto(chatId, collage, { caption });
  } catch (err) {
    console.error(err?.response?.data || err.message);
    bot.sendMessage(
      chatId,
      "صار خطأ أثناء البحث/إنشاء الصورة 😅\nافتح Logs في Render وابعث لي نص الخطأ (بدون أسرار) إذا بدك أصلّحه بسرعة."
    );
  }
});

console.log("Deals48 bot running (polling)...");
