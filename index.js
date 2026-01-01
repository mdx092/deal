require("dotenv").config();

const http = require("http");
const crypto = require("crypto");
const axios = require("axios");
const sharp = require("sharp");
const TelegramBot = require("node-telegram-bot-api");

/* =========================
   ENV
========================= */
const token = process.env.TELEGRAM_BOT_TOKEN;
if (!token) throw new Error("Missing TELEGRAM_BOT_TOKEN");

const PUBLIC_URL = process.env.PUBLIC_URL; // مثال: https://deal-jsyn.onrender.com
if (!PUBLIC_URL) throw new Error("Missing PUBLIC_URL");

// AliExpress Open Platform keys (openservice)
const AE_APP_KEY = (process.env.AE_APP_KEY || "").trim();
const AE_APP_SECRET = (process.env.AE_APP_SECRET || "").trim();
const TRACKING_ID = (process.env.TRACKING_ID || "").trim(); // اختياري

if (!AE_APP_KEY || !AE_APP_SECRET) {
  throw new Error("Missing AE_APP_KEY or AE_APP_SECRET");
}

// مهم: بوابة AliExpress (مش taobao)
const AE_GATEWAY =
  (process.env.AE_GATEWAY || "").trim() || "https://api-sg.aliexpress.com/sync";

const DEBUG = String(process.env.DEBUG || "").trim() === "1";

// تحويل USD→ILS اختياري
const USD_TO_ILS_RATE = Number(process.env.USD_TO_ILS_RATE || "0");
function usdToIls(usdStr) {
  const usd = Number(String(usdStr).replace(/[^\d.]/g, ""));
  if (!Number.isFinite(usd) || usd <= 0) return null;
  if (!USD_TO_ILS_RATE || USD_TO_ILS_RATE <= 0) return null;
  return usd * USD_TO_ILS_RATE;
}

/* =========================
   Telegram webhook server
========================= */
const bot = new TelegramBot(token); // no polling
const WEBHOOK_PATH = `/bot${token}`;
const PORT = process.env.PORT || 10000;

bot
  .setWebHook(`${PUBLIC_URL}${WEBHOOK_PATH}`)
  .then(() => console.log("Webhook set ✅"))
  .catch((e) => console.error("Webhook error:", e?.message || e));

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

    res.writeHead(404);
    res.end("Not found");
  })
  .listen(PORT, () => console.log("Server listening on", PORT));

console.log("Deals48 bot running (webhook mode)...");

/* =========================
   Helpers: timestamp + sign
========================= */
function shanghaiTimestamp() {
  // sv-SE يعطي فورمات: YYYY-MM-DD HH:mm:ss
  return new Intl.DateTimeFormat("sv-SE", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(new Date());
}

function md5Upper(s) {
  return crypto.createHash("md5").update(s, "utf8").digest("hex").toUpperCase();
}

// توقيع TOP-style: secret + (k+v...) + secret
function signTopPairs(params, secret) {
  const sortedKeys = Object.keys(params).sort();
  let base = secret;
  for (const k of sortedKeys) {
    const v = params[k];
    if (v === undefined || v === null || v === "") continue;
    base += `${k}${v}`;
  }
  base += secret;
  return md5Upper(base);
}

function sanitizeForLog(obj) {
  const s = JSON.stringify(obj);
  return s
    .replace(/"sign"\s*:\s*"[^"]+"/g, '"sign":"***"')
    .replace(/"app_key"\s*:\s*"[^"]+"/g, '"app_key":"***"')
    .slice(0, 1400);
}

async function postForm(url, params) {
  const body = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) body.append(k, String(v));

  const res = await axios.post(url, body, {
    headers: { "Content-Type": "application/x-www-form-urlencoded;charset=utf-8" },
    timeout: 25000,
  });

  return res.data;
}

/* =========================
   Telegram: send long text safely
========================= */
async function sendLongMessage(chatId, text, opts = {}) {
  const MAX = 3900; // أقل من 4096 للأمان
  let remaining = text;

  while (remaining.length > 0) {
    const chunk = remaining.slice(0, MAX);
    remaining = remaining.slice(MAX);
    await bot.sendMessage(chatId, chunk, opts);
  }
}

/* =========================
   AliExpress Affiliate call
========================= */
async function callAffiliate(method, bizParams) {
  const params = {
    method,
    app_key: AE_APP_KEY,
    sign_method: "md5",
    format: "json",
    v: "2.0",
    timestamp: shanghaiTimestamp(),
    ...bizParams,
  };

  params.sign = signTopPairs(params, AE_APP_SECRET);

  if (DEBUG) {
    console.log("API CALL:", sanitizeForLog({ gw: AE_GATEWAY, method, bizParams }));
  }

  const data = await postForm(AE_GATEWAY, params);

  const err = data?.error_response;
  if (err) console.log("API ERROR:", sanitizeForLog(err));

  return data;
}

function extractProducts(resp) {
  const root =
    resp?.aliexpress_affiliate_product_query_response ||
    resp?.aliexpress_affiliate_product_query_resp ||
    resp;

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
      const title = p?.product_title || "بدون عنوان";
      const image = p?.product_main_image_url || "";
      const detailUrl = p?.product_detail_url || "";

      const priceVal =
        p?.app_sale_price || p?.sale_price || p?.original_price || "";
      const currency =
        p?.app_sale_price_currency || p?.sale_price_currency || "USD";

      const orders = Number(p?.lastest_volume || p?.volume || 0) || 0;
      const rating = p?.evaluate_rate || "—";

      return { title, image, detailUrl, priceVal, currency, orders, rating };
    })
    .filter((x) => x.image && x.detailUrl)
    .sort((a, b) => b.orders - a.orders);
}

function formatPrice(p) {
  if (String(p.currency).toUpperCase() === "USD") {
    const ils = usdToIls(p.priceVal);
    if (ils !== null) return `₪${ils.toFixed(2)} (USD ${p.priceVal})`;
  }
  return `${p.currency} ${p.priceVal}`;
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

/* =========================
   Telegram handlers
========================= */
bot.onText(/\/start/, (msg) => {
  bot.sendMessage(
    msg.chat.id,
    "أهلًا 👋\nاكتب مثلًا:\nابحث عن ساعة ذكية\nابحث عن شاحن 65W"
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
  if (!query) return;

  try {
    bot.sendChatAction(chatId, "upload_photo");

    const resp = await callAffiliate("aliexpress.affiliate.product.query", {
      keywords: query,
      page_no: 1,
      page_size: 50,
      sort: "LAST_VOLUME_DESC",
      target_language: "AR",
      target_currency: "USD",
      tracking_id: TRACKING_ID, // إذا فاضي مش مشكلة
    });

    const raw = extractProducts(resp);
    const all = normalizeProducts(raw);

    console.log(`rawProducts: ${raw.length} normalized: ${all.length}`);

    if (all.length < 4) {
      return bot.sendMessage(chatId, "ما لقيت نتائج كافية. جرّب كلمة ثانية 🙂");
    }

    const top4 = all.slice(0, 4);

    // كولاج
    const collage = await buildCollage(top4);

    // كابتشن قصير (أقل من 1024)
    const shortCaption =
      `🔥 أفضل 4 منتجات (الأكثر طلبًا)\n` +
      `🔎 البحث: ${query}\n` +
      `📩 التفاصيل بالرسالة التالية ⬇️`;

    // تفاصيل برسالة منفصلة (4096 حد أعلى)
    let details = `🔥 نتائج البحث: ${query}\n\n`;
    top4.forEach((p, i) => {
      details += `${["1️⃣","2️⃣","3️⃣","4️⃣"][i]} ${p.title}\n`;
      details += `💰 السعر: ${formatPrice(p)}\n`;
      details += `🛒 المبيعات: ${p.orders}\n`;
      details += `⭐ التقييم: ${p.rating}\n`;
      details += `🔗 الرابط: ${p.detailUrl}\n\n`;
    });

    // أرسل الصورة مع اسم ملف (لتقليل تحذير node-telegram-bot-api)
    await bot.sendPhoto(
      chatId,
      collage,
      { caption: shortCaption },
      { filename: "collage.jpg", contentType: "image/jpeg" }
    );

    await sendLongMessage(chatId, details, { disable_web_page_preview: true });
  } catch (e) {
    console.error("BOT ERROR:", e?.response?.data || e?.message);
    bot.sendMessage(chatId, "صار خطأ. افتح Logs وابعتلي سطر API ERROR إذا ظهر.");
  }
});
