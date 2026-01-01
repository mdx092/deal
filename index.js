require("dotenv").config();

const axios = require("axios");
const crypto = require("crypto");
const sharp = require("sharp");
const http = require("http");
const TelegramBot = require("node-telegram-bot-api");

/* =========================================================
   ENV
   ========================================================= */
const token = process.env.TELEGRAM_BOT_TOKEN;
if (!token) throw new Error("Missing TELEGRAM_BOT_TOKEN");

const PUBLIC_URL = process.env.PUBLIC_URL; // مثل: https://deal-jsyn.onrender.com
if (!PUBLIC_URL) throw new Error("Missing PUBLIC_URL");

const AE_GATEWAY = process.env.AE_GATEWAY || "https://api.taobao.com/router/rest";
const AE_APP_KEY = process.env.AE_APP_KEY;
const AE_APP_SECRET = process.env.AE_APP_SECRET;
const TRACKING_ID = process.env.TRACKING_ID;

if (!AE_APP_KEY || !AE_APP_SECRET) throw new Error("Missing AE_APP_KEY or AE_APP_SECRET");
if (!TRACKING_ID) throw new Error("Missing TRACKING_ID (required for affiliate links)");

/* =========================================================
   Telegram: Webhook mode (no polling)
   ========================================================= */
const bot = new TelegramBot(token); // ✅ no polling
const WEBHOOK_PATH = `/bot${token}`;
const PORT = process.env.PORT || 3000;

// Set webhook
bot.setWebHook(`${PUBLIC_URL}${WEBHOOK_PATH}`);
console.log("Webhook set ✅");

// HTTP server: health + webhook receiver
http
  .createServer((req, res) => {
    if (req.method === "GET" && req.url === "/") {
      res.writeHead(200, { "Content-Type": "text/plain" });
      return res.end("OK");
    }

    if (req.method === "POST" && req.url === WEBHOOK_PATH) {
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", () => {
        try {
          const update = JSON.parse(body);
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

/* =========================================================
   TOP / AliExpress Official API helpers
   ========================================================= */
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

/* =========================================================
   AliExpress Affiliate: Product Query
   - We request many, sorted by volume (highest sales)
   ========================================================= */
async function affiliateProductQuery(keyword) {
  return topPost("aliexpress.affiliate.product.query", {
    keywords: keyword,
    page_no: 1,
    page_size: 50,
    sort: "LAST_VOLUME_DESC",
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
  return products.map((p) => {
    const title = p?.product_title || "بدون عنوان";
    const priceVal = p?.app_sale_price || p?.sale_price || p?.original_price || "";
    const currency = p?.app_sale_price_currency || p?.sale_price_currency || "USD";
    const ordersNumber = Number(p?.lastest_volume || 0) || 0; // sales volume
    const rating = p?.evaluate_rate || "—"; // often percent
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
      affiliateLink: "",
    };
  });
}

/* =========================================================
   AliExpress Affiliate: Link Generate (affiliate links)
   ========================================================= */
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

/* =========================================================
   Collage (2x2) + numbered badges
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

  // separators
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
  msg += `🟠 اكتب: "ابحث عن ..."`;
  return msg;
}

/* =========================================================
   Telegram handlers
   ========================================================= */
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

    // 1) products sorted by sales
    const productData = await affiliateProductQuery(query);
    const rawProducts = extractProducts(productData);
    let all = normalizeProducts(rawProducts).filter((p) => p.image && p.detailUrl);

    if (all.length < 4) {
      return bot.sendMessage(chatId, "ما لقيت نتائج كافية. جرّب كلمة ثانية 🙂");
    }

    // top 4 (already highest volume)
    const top4 = all.slice(0, 4);

    // 2) generate affiliate links
    const urls = top4.map((p) => p.detailUrl);
    const linkData = await affiliateLinkGenerate(urls);
    const linksArr = extractPromotionLinks(linkData);

    const linkMap = new Map();
    for (const row of linksArr) {
      if (row?.source_value && row?.promotion_link) {
        linkMap.set(row.source_value, row.promotion_link);
      }
    }
    top4.forEach((p) => {
      p.affiliateLink = linkMap.get(p.detailUrl) || "";
    });

    // 3) collage + caption
    const collage = await buildCollage(top4);
    const caption = buildCaption(query, top4);

    await bot.sendPhoto(chatId, collage, { caption });
  } catch (err) {
    console.error(err?.response?.data || err.message);
    bot.sendMessage(
      chatId,
      "صار خطأ 😅\nتأكد أن PUBLIC_URL و TRACKING_ID موجودين في Render Environment، ثم جرّب مرة ثانية."
    );
  }
});

console.log("Deals48 bot running (webhook mode)...");
