import "dotenv/config";
import express from "express";
import TelegramBot from "node-telegram-bot-api";
import crypto from "crypto";
import dayjs from "dayjs";
import utc from "dayjs/plugin/utc.js";
import timezone from "dayjs/plugin/timezone.js";

dayjs.extend(utc);
dayjs.extend(timezone);

// =====================
// ENV
// =====================
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const AE_APP_KEY = process.env.AE_APP_KEY;
const AE_APP_SECRET = process.env.AE_APP_SECRET;
const AE_TRACKING_ID = process.env.AE_TRACKING_ID; // Tracking ID من AliExpress Portals
const AE_GATEWAY = process.env.AE_GATEWAY; // مهم! خليه https://api-sg.aliexpress.com/sync

if (!TELEGRAM_BOT_TOKEN) throw new Error("Missing TELEGRAM_BOT_TOKEN");
if (!AE_APP_KEY) console.warn("⚠️ Missing AE_APP_KEY");
if (!AE_APP_SECRET) console.warn("⚠️ Missing AE_APP_SECRET");
if (!AE_TRACKING_ID) console.warn("⚠️ Missing AE_TRACKING_ID (affiliate links may not work)");

// Render يعطيك الرابط العام
const PUBLIC_URL =
  process.env.RENDER_EXTERNAL_URL ||
  process.env.PUBLIC_URL ||
  process.env.APP_URL ||
  "";

const PORT = Number(process.env.PORT || 10000);

// =====================
// Express (Webhook server)
// =====================
const app = express();
app.use(express.json());

app.get("/", (_, res) => res.status(200).send("OK"));

const WEBHOOK_PATH = `/bot${TELEGRAM_BOT_TOKEN}`;

// =====================
// Telegram Bot (webhook mode)
// =====================
const bot = new TelegramBot(TELEGRAM_BOT_TOKEN);

if (!PUBLIC_URL) {
  console.warn(
    "⚠️ PUBLIC_URL not found. On Render set env RENDER_EXTERNAL_URL automatically. If webhook doesn't work, add PUBLIC_URL=https://your.onrender.com"
  );
} else {
  const webhookUrl = `${PUBLIC_URL}${WEBHOOK_PATH}`;
  bot
    .setWebHook(webhookUrl)
    .then(() => console.log("Webhook set ✅"))
    .catch((e) => console.error("Webhook set error:", e?.message || e));
}

app.post(WEBHOOK_PATH, (req, res) => {
  bot.processUpdate(req.body);
  res.sendStatus(200);
});

app.listen(PORT, () => console.log(`Server listening on ${PORT}`));

// =====================
// Bot UX
// =====================
bot.onText(/\/start/, async (msg) => {
  await bot.sendMessage(
    msg.chat.id,
    `أهلًا 👋\nاكتب مثلًا:\nابحث عن ساعة ذكية\nابحث لي عن شاحن 65W`
  );
});

bot.on("message", async (msg) => {
  try {
    if (!msg.text) return;
    if (msg.text.startsWith("/start")) return;

    const kw = extractKeyword(msg.text);
    if (!kw) return;

    await bot.sendChatAction(msg.chat.id, "typing");

    const products = await getTop4ByOrders(kw);

    if (!products || products.length < 4) {
      await bot.sendMessage(msg.chat.id, "ما لقيت نتائج كافية. جرّب كلمة ثانية 🙂");
      return;
    }

    // نص مرتب
    const lines = [];
    for (let i = 0; i < 4; i++) {
      const p = products[i];
      const price = formatILS(p.price);
      const orders = p.orders ?? "—";
      const rating = p.rating ?? "—";

      // رابط أفلييت (إذا فشل، بنستخدم رابط المنتج)
      const link = (await safeAffiliateLink(p.detailUrl)) || p.detailUrl;

      lines.push(
        `${["1️⃣","2️⃣","3️⃣","4️⃣"][i]} ${truncate(p.title, 70)}\n` +
        `💰 السعر: ${price}\n` +
        `🛒 المبيعات: ${orders}\n` +
        `⭐ التقييم: ${rating}\n` +
        `${link}`
      );
    }

    await bot.sendMessage(msg.chat.id, lines.join("\n\n"), {
      disable_web_page_preview: false,
    });
  } catch (e) {
    console.error("Message handler error:", e?.message || e);
    await bot.sendMessage(msg.chat.id, "صار خطأ بسيط. جرّب مرة ثانية 🙏");
  }
});

function extractKeyword(text) {
  const t = (text || "").trim();
  // أمثلة: "ابحث عن ..." / "ابحث لي عن ..." / "ابحث ..." / "بحث ..."
  const patterns = [
    /^ابحث\s+لي\s+عن\s+/,
    /^ابحث\s+عن\s+/,
    /^ابحث\s+/,
    /^بحث\s+عن\s+/,
  ];
  for (const re of patterns) {
    if (re.test(t)) return t.replace(re, "").trim();
  }
  // إذا كتب كلمة مباشرة
  if (t.length >= 2) return t;
  return "";
}

function truncate(s, n) {
  if (!s) return "";
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}

function formatILS(price) {
  if (price === null || price === undefined) return "—";
  const num = Number(price);
  if (Number.isFinite(num)) return `₪${num.toFixed(2)}`;
  // إذا جاي نص
  const p = String(price);
  return p.includes("₪") ? p : `₪${p}`;
}

// =====================
// AliExpress API
// =====================

// جرّب أكثر من Gateway (الأهم api-sg)
function buildGateways() {
  const list = [
    AE_GATEWAY, // إذا محدد في Render
    "https://api-sg.aliexpress.com/sync", // شائع للـ Affiliate APIs :contentReference[oaicite:2]{index=2}
    // احتياط (قد يفيد لبعض الحسابات القديمة، لكنه قد يعطي appkey-not-exists)
    "https://eco.taobao.com/router/rest",
    "https://gw.api.taobao.com/router/rest",
  ].filter(Boolean);

  // إزالة تكرار
  return [...new Set(list)];
}

function md5Upper(s) {
  return crypto.createHash("md5").update(s, "utf8").digest("hex").toUpperCase();
}

function sortKeys(obj) {
  return Object.keys(obj)
    .sort()
    .reduce((acc, k) => {
      acc[k] = obj[k];
      return acc;
    }, {});
}

// توقيع “TOP style”: keyvaluekeyvalue (مثل شروحات كثيرة) :contentReference[oaicite:3]{index=3}
function signTopPairs(params, secret) {
  const sorted = sortKeys({ ...params });
  delete sorted.sign;

  let long = "";
  for (const k of Object.keys(sorted)) {
    const v = sorted[k];
    if (v === undefined || v === null || v === "") continue;
    long += `${k}${v}`;
  }
  return md5Upper(`${secret}${long}${secret}`);
}

// توقيع “querystring style”: key=value&key=value (يظهر في أمثلة كثيرة للـ /sync)
function signQueryString(params, secret) {
  const sorted = sortKeys({ ...params });
  delete sorted.sign;

  const qs = Object.keys(sorted)
    .filter((k) => sorted[k] !== undefined && sorted[k] !== null && sorted[k] !== "")
    .map((k) => `${k}=${sorted[k]}`)
    .join("&");

  return md5Upper(`${secret}${qs}${secret}`);
}

async function postForm(url, params) {
  const body = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) body.append(k, String(v));

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded;charset=utf-8" },
    body,
  });

  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

function pickProductsFromResponse(resp) {
  // أشكال مختلفة حسب الـ gateway
  // Taobao/TOP:
  // resp.aliexpress_affiliate_product_query_response?.resp_result?.result?.products?.product
  const a =
    resp?.aliexpress_affiliate_product_query_response?.resp_result?.result?.products?.product;

  if (Array.isArray(a)) return a;

  // أحيانًا تكون products.product عنصر واحد
  if (a && typeof a === "object") return [a];

  // بعض الردود قد تكون مباشرة:
  const b = resp?.result?.products?.product;
  if (Array.isArray(b)) return b;
  if (b && typeof b === "object") return [b];

  return [];
}

function normalizeProduct(p) {
  const title =
    p?.product_title || p?.title || p?.productTitle || p?.item_title || "";

  const img =
    p?.product_main_image_url || p?.productMainImageUrl || p?.image_url || p?.imageUrl || "";

  const detailUrl =
    p?.product_detail_url || p?.productDetailUrl || p?.detail_url || p?.product_url || "";

  // السعر: أحيانًا sale_price مثل "US $12.34"
  const sale = p?.sale_price || p?.target_sale_price || p?.salePrice || p?.price || "";
  const price = extractNumber(sale);

  // المبيعات: orders أو volume
  const orders =
    toInt(p?.orders) ??
    toInt(p?.lastest_volume) ??
    toInt(p?.volume) ??
    toInt(p?.sale_num) ??
    null;

  // التقييم: evaluate_rate أو rating
  const rating =
    p?.evaluate_rate ||
    p?.evaluateRate ||
    p?.rating ||
    p?.score ||
    null;

  return {
    title: title || "منتج",
    img,
    detailUrl,
    price,
    orders,
    rating,
  };
}

function extractNumber(x) {
  if (x === null || x === undefined) return null;
  const s = String(x);
  const m = s.match(/(\d+(\.\d+)?)/);
  return m ? Number(m[1]) : null;
}

function toInt(x) {
  if (x === null || x === undefined) return null;
  const n = Number(String(x).replace(/[^\d]/g, ""));
  return Number.isFinite(n) ? n : null;
}

async function callAffiliate(method, extraParams) {
  if (!AE_APP_KEY || !AE_APP_SECRET) {
    return { error: "Missing AE_APP_KEY/AE_APP_SECRET" };
  }

  const gateways = buildGateways();

  // جرّب نوعين timestamp + نوعين توقيع
  const tsShanghai = dayjs().tz("Asia/Shanghai").format("YYYY-MM-DD HH:mm:ss"); // :contentReference[oaicite:4]{index=4}
  const tsUnix = Math.floor(Date.now() / 1000);

  const attempts = [
    { timestamp: tsShanghai, signFn: signTopPairs, tag: "shanghai/topPairs" },
    { timestamp: tsShanghai, signFn: signQueryString, tag: "shanghai/queryStr" },
    { timestamp: tsUnix, signFn: signTopPairs, tag: "unix/topPairs" },
    { timestamp: tsUnix, signFn: signQueryString, tag: "unix/queryStr" },
  ];

  let lastResp = null;

  for (const gw of gateways) {
    for (const att of attempts) {
      const payload = {
        method,
        app_key: AE_APP_KEY,
        sign_method: "md5",
        format: "json",
        v: "2.0",
        timestamp: att.timestamp,
        ...extraParams,
      };

      const sign = att.signFn(payload, AE_APP_SECRET);
      const full = { ...payload, sign };

      // لوج مختصر بدون أسرار
      console.log(`API TRY -> gw=${gw} method=${method} (${att.tag})`);

      const resp = await postForm(gw, full);
      lastResp = resp;

      // أخطاء TOP غالبًا تحت error_response
      const err = resp?.error_response;
      if (!err) return resp;

      // لو المشكلة appkey-not-exists على بوابة معينة: انتقل للبوابة التالية مباشرة
      const sub = err?.sub_code || "";
      if (String(sub).includes("appkey-not-exists")) {
        console.log(`API ERROR appkey-not-exists on gw=${gw} -> switch gateway`);
        break;
      }

      // لو مشكلة توقيع: جرّب attempt التالي
      console.log(`API ERROR -> ${err?.code} ${err?.msg} sub=${sub || "-"}`);
    }
  }

  return lastResp || { error: "No response" };
}

async function getTop4ByOrders(keyword) {
  // 1) استعلام منتجات
  const resp = await callAffiliate("aliexpress.affiliate.product.query", {
    keywords: keyword,
    page_no: 1,
    page_size: 50,
    // إعدادات لغة/عملة حسب احتياجك (قد لا تُطبق في كل الحالات)
    target_language: "AR",
    target_currency: "ILS",
    // بعض الحسابات تحتاج tracking_id حتى في query
    tracking_id: AE_TRACKING_ID || "",
  });

  const raw = pickProductsFromResponse(resp);
  const norm = raw.map(normalizeProduct).filter((p) => p.detailUrl);

  console.log(`rawProducts: ${raw.length} normalized: ${norm.length}`);

  // فلترة أعلى مبيعات
  const sorted = norm
    .filter((p) => p.img) // بدنا صورة للكولاج لاحقًا
    .sort((a, b) => (b.orders || 0) - (a.orders || 0));

  return sorted.slice(0, 4);
}

async function safeAffiliateLink(detailUrl) {
  try {
    if (!detailUrl) return "";
    if (!AE_TRACKING_ID) return detailUrl;

    const resp = await callAffiliate("aliexpress.affiliate.link.generate", {
      promotion_link_type: 0,
      source_values: detailUrl,
      tracking_id: AE_TRACKING_ID,
    });

    // أشكال مختلفة للرد
    const link =
      resp?.aliexpress_affiliate_link_generate_response?.resp_result?.result?.promotion_links?.promotion_link?.[0]?.promotion_link ||
      resp?.aliexpress_affiliate_link_generate_response?.resp_result?.result?.promotion_links?.promotion_link?.promotion_link ||
      resp?.result?.promotion_links?.promotion_link?.[0]?.promotion_link ||
      "";

    return link || detailUrl;
  } catch {
    return detailUrl;
  }
}
