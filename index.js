/**
 * Deals48 AI Bot (AliExpress Affiliate + GPT rerank + Arabic titles)
 * Webhook mode for Render (Express).
 *
 * ENV required:
 *  - TELEGRAM_BOT_TOKEN
 *  - ALI_APP_KEY
 *  - ALI_APP_SECRET
 *  - ALI_TRACKING_ID
 *  - BASE_URL                 (e.g. https://deal-jsyn.onrender.com)  // Render public URL
 * Optional (for GPT):
 *  - OPENAI_API_KEY
 *  - OPENAI_MODEL             (default: gpt-4.1-mini)
 */

import express from "express";
import crypto from "crypto";
import TelegramBot from "node-telegram-bot-api";
import axios from "axios";
import sharp from "sharp";
import OpenAI from "openai";

const {
  TELEGRAM_BOT_TOKEN,
  ALI_APP_KEY,
  ALI_APP_SECRET,
  ALI_TRACKING_ID,
  BASE_URL,
  OPENAI_API_KEY,
  OPENAI_MODEL,
} = process.env;

if (!TELEGRAM_BOT_TOKEN) throw new Error("Missing TELEGRAM_BOT_TOKEN");
if (!ALI_APP_KEY) throw new Error("Missing ALI_APP_KEY");
if (!ALI_APP_SECRET) throw new Error("Missing ALI_APP_SECRET");
if (!ALI_TRACKING_ID) throw new Error("Missing ALI_TRACKING_ID");
if (!BASE_URL) throw new Error("Missing BASE_URL (e.g. https://xxxx.onrender.com)");

const PORT = Number(process.env.PORT || 10000);
const WEBHOOK_PATH = `/bot${TELEGRAM_BOT_TOKEN}`;
const WEBHOOK_URL = `${BASE_URL}${WEBHOOK_PATH}`;

const bot = new TelegramBot(TELEGRAM_BOT_TOKEN, { webHook: true });
const app = express();
app.use(express.json({ limit: "5mb" }));

// OpenAI client (optional)
const openai = OPENAI_API_KEY ? new OpenAI({ apiKey: OPENAI_API_KEY }) : null;
const AI_MODEL = OPENAI_MODEL || "gpt-4.1-mini";

// -----------------------------
// Helpers (numbers/strings)
// -----------------------------
function toNumber(x) {
  if (x == null) return null;
  const s = String(x).replace(/[^\d.]/g, "");
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

function cleanTitleBasic(title) {
  if (!title) return "";
  let t = String(title).trim();
  t = t.replace(/\s+/g, " ");
  // remove trailing dots/ellipses
  t = t.replace(/[.…]+$/g, "").trim();
  // remove junk tokens
  t = t.replace(/\b(Official|Original|New|Hot|Sale|202\d)\b/gi, "").trim();
  t = t.replace(/\s+/g, " ").trim();
  return t;
}

function shortTitleNoDots(title, maxLen = 46) {
  const t = cleanTitleBasic(title);
  if (t.length <= maxLen) return t;
  // cut to word boundary WITHOUT "..."
  const cut = t.slice(0, maxLen).trim();
  const lastSpace = cut.lastIndexOf(" ");
  return (lastSpace > 12 ? cut.slice(0, lastSpace) : cut).replace(/[.…]+$/g, "").trim();
}

function formatRating5(x) {
  const n = toNumber(x);
  if (n == null) return null;

  // sometimes API gives percent like 98.0
  if (n > 5 && n <= 100) {
    // map 0..100 -> 0..5
    const mapped = (n / 100) * 5;
    return `${mapped.toFixed(1)}/5`;
  }
  // normal 0..5
  const v = Math.max(0, Math.min(5, n));
  return `${v.toFixed(1)}/5`;
}

function formatILS(priceMaybe) {
  // price may be "ILS 39.70" or "39.70" with separate currency
  if (priceMaybe == null) return null;
  const s = String(priceMaybe);
  const n = toNumber(s);
  if (n == null) return null;
  return `₪${n.toFixed(2)}`;
}

function uniqBy(arr, keyFn) {
  const seen = new Set();
  const out = [];
  for (const x of arr) {
    const k = keyFn(x);
    if (!k || seen.has(k)) continue;
    seen.add(k);
    out.push(x);
  }
  return out;
}

// -----------------------------
// AliExpress TOP signing + calls
// -----------------------------
function topTimestamp() {
  // YYYY-MM-DD HH:mm:ss
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  const YYYY = d.getFullYear();
  const MM = pad(d.getMonth() + 1);
  const DD = pad(d.getDate());
  const hh = pad(d.getHours());
  const mm = pad(d.getMinutes());
  const ss = pad(d.getSeconds());
  return `${YYYY}-${MM}-${DD} ${hh}:${mm}:${ss}`;
}

function topSign(params, secret) {
  // TOP signature MD5: secret + (sorted key+value) + secret, uppercase
  const keys = Object.keys(params)
    .filter((k) => params[k] !== undefined && params[k] !== null && params[k] !== "")
    .sort();

  let base = secret;
  for (const k of keys) base += `${k}${params[k]}`;
  base += secret;

  const md5 = crypto.createHash("md5").update(base, "utf8").digest("hex");
  return md5.toUpperCase();
}

async function topCall(method, bizParams) {
  const gateway = "https://api.taobao.com/router/rest"; // standard TOP gateway

  const params = {
    app_key: String(ALI_APP_KEY),
    method,
    format: "json",
    v: "2.0",
    sign_method: "md5",
    timestamp: topTimestamp(),
    ...bizParams,
  };

  params.sign = topSign(params, String(ALI_APP_SECRET));

  const body = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) body.append(k, String(v));

  const resp = await axios.post(gateway, body.toString(), {
    headers: { "Content-Type": "application/x-www-form-urlencoded;charset=utf-8" },
    timeout: 20000,
  });

  return resp.data;
}

function extractProductsFromQueryResp(data) {
  // Different accounts respond with slightly different shapes → be defensive
  const root =
    data?.aliexpress_affiliate_product_query_response ||
    data?.aliexpress_affiliate_product_query_response?.resp_result;

  const respResult = root?.resp_result || root?.result || data?.resp_result || data?.result;

  const result = respResult?.result || respResult;
  const products =
    result?.products?.product ||
    result?.products ||
    result?.result_list?.map?.product ||
    result?.result_list ||
    [];

  return Array.isArray(products) ? products : (products ? [products] : []);
}

async function affiliateProductQuery(keyword, pageNo = 1) {
  // IMPORTANT: request ILS + Arabic + ship to Israel
  const bizParams = {
    keywords: keyword,
    tracking_id: ALI_TRACKING_ID,
    target_language: "AR",
    target_currency: "ILS",
    ship_to_country: "IL",
    page_no: String(pageNo),
    page_size: "50",
    sort: "LAST_VOLUME_DESC", // sales desc (if supported)
  };

  const data = await topCall("aliexpress.affiliate.product.query", bizParams);
  // handle error shape
  if (data?.error_response) {
    return { ok: false, error: data.error_response, products: [] };
  }
  const products = extractProductsFromQueryResp(data);

  return { ok: true, products, raw: data };
}

async function affiliateLinkGenerate(urls) {
  // generate affiliate links for URLs (comma separated)
  const bizParams = {
    tracking_id: ALI_TRACKING_ID,
    promotion_link_type: "0",
    source_values: urls.join(","),
  };

  const data = await topCall("aliexpress.affiliate.link.generate", bizParams);
  if (data?.error_response) {
    return { ok: false, error: data.error_response, links: [] };
  }

  const root = data?.aliexpress_affiliate_link_generate_response;
  const respResult = root?.resp_result || root?.result || data?.resp_result || data?.result;
  const result = respResult?.result || respResult;

  const promotionLinks =
    result?.promotion_links?.promotion_link ||
    result?.promotion_links ||
    [];

  const linksArr = Array.isArray(promotionLinks) ? promotionLinks : (promotionLinks ? [promotionLinks] : []);
  return { ok: true, links: linksArr, raw: data };
}

// -----------------------------
// GPT: keyword expansion + rerank + Arabic titles
// -----------------------------
async function aiExpandKeywords(userQuery) {
  if (!openai) {
    // fallback: basic expansion only
    const q = userQuery.trim();
    const enGuess = q; // no translation without GPT
    return [q, enGuess].filter(Boolean);
  }

  const prompt = `حوّل طلب المستخدم إلى كلمات بحث ممتازة لعلي إكسبريس.
- أعطني 4 كلمات بحث كحد أقصى.
- لازم تشمل: نسخة عربية قصيرة + نسخة إنجليزية إن أمكن + مرادفات مفيدة.
- بدون رموز، بدون شرح.

طلب المستخدم: ${userQuery}`;

  const r = await openai.responses.create({
    model: AI_MODEL,
    input: prompt,
    // keep it short
    max_output_tokens: 200,
  });

  const text = (r.output_text || "").trim();
  // parse lines
  const lines = text
    .split("\n")
    .map((x) => x.replace(/^[-•\d.]+\s*/, "").trim())
    .filter(Boolean);

  // keep unique
  const out = [];
  for (const l of lines) {
    if (l.length < 2) continue;
    if (!out.includes(l)) out.push(l);
    if (out.length >= 4) break;
  }
  return out.length ? out : [userQuery.trim()];
}

async function aiRerankAndTitle(userQuery, products) {
  if (!openai) return null;

  // send compact list
  const payload = products.slice(0, 20).map((p) => ({
    product_id: p.product_id || p.productId || p.item_id || p.itemId,
    title: p.product_title || p.productTitle || p.title,
    orders:
      p.last_volume ?? p.lastVolume ?? p.volume ?? p.sales ?? p.total_orders ?? p.orders,
    rating: p.evaluate_rate ?? p.evaluateRate ?? p.rating ?? p.score,
    price:
      p.target_app_sale_price ??
      p.targetAppSalePrice ??
      p.app_sale_price ??
      p.appSalePrice ??
      p.sale_price ??
      p.salePrice ??
      p.original_price ??
      p.originalPrice,
  }));

  const instruction = `أنت مساعد لتحسين نتائج بحث منتجات علي إكسبريس.
المطلوب:
1) فلترة المنتجات غير المرتبطة بطلب المستخدم.
2) لكل منتج مرتبط: اكتب عنوانًا عربيًا قصيرًا وواضحًا (بدون ... نهائيًا).
3) أعطِ درجة ملاءمة 0..100.

قواعد العنوان:
- عربي فصيح بسيط أو لهجة محايدة.
- 3 إلى 8 كلمات.
- لا تكتب أسماء طويلة/أرقام عشوائية إلا إذا مهمة (مثل 65W, USB-C, LG).
- لا تضع نقاط في النهاية.

ارجع JSON فقط بهذا الشكل:
{
  "items":[
    {"product_id":"...","short_title_ar":"...","relevance":80}
  ]
}`;

  const r = await openai.responses.create({
    model: AI_MODEL,
    input: [
      { role: "system", content: instruction },
      { role: "user", content: `طلب المستخدم: ${userQuery}\n\nالمنتجات:\n${JSON.stringify(payload)}` },
    ],
    max_output_tokens: 800,
  });

  const txt = (r.output_text || "").trim();

  // best-effort JSON parse
  try {
    const jsonStart = txt.indexOf("{");
    const jsonEnd = txt.lastIndexOf("}");
    const jsonStr = jsonStart >= 0 && jsonEnd > jsonStart ? txt.slice(jsonStart, jsonEnd + 1) : txt;
    const parsed = JSON.parse(jsonStr);
    if (!parsed?.items || !Array.isArray(parsed.items)) return null;
    return parsed.items;
  } catch {
    return null;
  }
}

// -----------------------------
// Product normalization
// -----------------------------
function normalizeProduct(p) {
  const productId = String(p.product_id || p.productId || p.item_id || p.itemId || "").trim();
  const title = p.product_title || p.productTitle || p.title || "";
  const img =
    p.product_main_image_url ||
    p.productMainImageUrl ||
    p.main_image_url ||
    p.mainImageUrl ||
    p.image_url ||
    p.imageUrl ||
    p.product_image ||
    p.productImage ||
    "";
  const productUrl =
    p.product_detail_url ||
    p.productDetailUrl ||
    p.product_url ||
    p.productUrl ||
    p.item_url ||
    p.itemUrl ||
    "";

  const ordersRaw =
    p.last_volume ?? p.lastVolume ?? p.volume ?? p.sales ?? p.total_orders ?? p.orders ?? 0;

  const ratingRaw =
    p.evaluate_rate ?? p.evaluateRate ?? p.rating ?? p.score ?? null;

  const priceRaw =
    p.target_app_sale_price ??
    p.targetAppSalePrice ??
    p.app_sale_price ??
    p.appSalePrice ??
    p.sale_price ??
    p.salePrice ??
    p.original_price ??
    p.originalPrice ??
    null;

  const promo =
    p.promotion_link ||
    p.promotionLink ||
    p.promo_link ||
    p.promoLink ||
    p.promotion_url ||
    p.promotionUrl ||
    "";

  return {
    productId,
    title,
    img,
    productUrl,
    promotionLink: promo,
    orders: toNumber(ordersRaw) ?? 0,
    rating: toNumber(ratingRaw),
    rating5: formatRating5(ratingRaw),
    priceILS: formatILS(priceRaw), // expects API to return ILS
    priceNum: toNumber(priceRaw),
    raw: p,
  };
}

function scoreSort(a, b) {
  // sales desc, rating desc, price asc
  if ((b.orders || 0) !== (a.orders || 0)) return (b.orders || 0) - (a.orders || 0);
  const ar = a.rating ?? -1;
  const br = b.rating ?? -1;
  if (br !== ar) return br - ar;
  const ap = a.priceNum ?? Number.POSITIVE_INFINITY;
  const bp = b.priceNum ?? Number.POSITIVE_INFINITY;
  return ap - bp;
}

// -----------------------------
// Collage (4 images) with SMALLER numbers
// -----------------------------
async function makeCollage4(images, outPath) {
  // images: array of {url, labelNumber}
  const size = 640; // each tile
  const canvasW = size * 2;
  const canvasH = size * 2;

  const downloads = await Promise.all(
    images.map(async (it) => {
      const r = await axios.get(it.url, { responseType: "arraybuffer", timeout: 20000 });
      const buf = Buffer.from(r.data);
      const resized = await sharp(buf).resize(size, size, { fit: "cover" }).toBuffer();
      return { ...it, buf: resized };
    })
  );

  const base = sharp({
    create: {
      width: canvasW,
      height: canvasH,
      channels: 3,
      background: { r: 255, g: 255, b: 255 },
    },
  });

  const composites = [];
  const positions = [
    { left: 0, top: 0 },
    { left: size, top: 0 },
    { left: 0, top: size },
    { left: size, top: size },
  ];

  for (let i = 0; i < downloads.length; i++) {
    const pos = positions[i];
    composites.push({ input: downloads[i].buf, left: pos.left, top: pos.top });

    // smaller number badge
    const badgeSize = 44;      // أصغر من قبل
    const fontSize = 22;
    const cx = pos.left + 40;
    const cy = pos.top + 40;

    const svg = `
      <svg width="${badgeSize}" height="${badgeSize}">
        <circle cx="${badgeSize / 2}" cy="${badgeSize / 2}" r="${badgeSize / 2}" fill="#ff6a00"/>
        <text x="50%" y="58%" text-anchor="middle"
              font-family="Arial" font-size="${fontSize}" font-weight="700" fill="#ffffff">${i + 1}</text>
      </svg>
    `;
    composites.push({ input: Buffer.from(svg), left: cx - badgeSize / 2, top: cy - badgeSize / 2 });
  }

  await base.composite(composites).jpeg({ quality: 90 }).toFile(outPath);
}

// -----------------------------
// Main search pipeline
// -----------------------------
async function searchBestProducts(userQuery) {
  // 1) GPT expand keywords (or fallback)
  const keywords = await aiExpandKeywords(userQuery);

  // 2) Call AliExpress multiple times and merge
  let all = [];
  for (const kw of keywords) {
    try {
      const r = await affiliateProductQuery(kw, 1);
      if (r.ok) all.push(...r.products);
    } catch {
      // ignore one kw failure
    }
  }

  // normalize + remove duplicates early
  let normalized = all.map(normalizeProduct);
  normalized = normalized.filter((p) => p.productId && p.img); // must have image for collage
  normalized = uniqBy(normalized, (p) => p.productId);

  // 3) If promotion links missing, generate them (only keep those that succeed)
  const missingPromo = normalized.filter((p) => !p.promotionLink && p.productUrl).slice(0, 50);
  if (missingPromo.length) {
    const urls = missingPromo.map((p) => p.productUrl);
    const gen = await affiliateLinkGenerate(urls);
    if (gen.ok) {
      const map = new Map();
      for (const it of gen.links) {
        const src = it?.source_value || it?.sourceValue;
        const pl = it?.promotion_link || it?.promotionLink;
        if (src && pl) map.set(String(src), String(pl));
      }
      normalized = normalized.map((p) => ({
        ...p,
        promotionLink: p.promotionLink || map.get(p.productUrl) || "",
      }));
    }
  }

  // keep ONLY affiliate links
  normalized = normalized.filter((p) => !!p.promotionLink);

  // 4) AI rerank + Arabic short titles
  const ai = await aiRerankAndTitle(userQuery, normalized);
  if (ai) {
    const aiMap = new Map(ai.map((x) => [String(x.product_id), x]));
    normalized = normalized
      .map((p) => {
        const m = aiMap.get(String(p.productId));
        return {
          ...p,
          aiRelevance: m?.relevance ?? null,
          aiTitle: m?.short_title_ar ? String(m.short_title_ar).trim() : null,
        };
      })
      .filter((p) => (p.aiRelevance ?? 0) >= 55); // فلترة قوية
  }

  // 5) Final sort (sales, rating, price) and pick up to 4
  normalized.sort(scoreSort);

  // ensure no duplicates by promo link too
  normalized = uniqBy(normalized, (p) => p.promotionLink);

  // If fewer than 4 after AI filter, relax a bit
  if (normalized.length < 4) {
    const fallback = all.map(normalizeProduct);
    const clean = uniqBy(fallback, (p) => p.productId)
      .filter((p) => p.productId && p.img && p.promotionLink);
    clean.sort(scoreSort);
    // merge without duplicates
    const merged = uniqBy([...normalized, ...clean], (p) => p.productId);
    normalized = merged.slice(0, 4);
  } else {
    normalized = normalized.slice(0, 4);
  }

  // polish titles (no dots)
  normalized = normalized.map((p) => {
    const finalTitle = p.aiTitle ? cleanTitleBasic(p.aiTitle) : shortTitleNoDots(p.title);
    return {
      ...p,
      finalTitle: shortTitleNoDots(finalTitle, 46),
    };
  });

  return normalized;
}

// -----------------------------
// Telegram text formatting
// -----------------------------
function buildMessage(userQuery, items) {
  // ترتيب: المبيعات ثم التقييم ثم السعر
  const header = `🔎 البحث: ${userQuery}`;
  const parts = [header, ""];
  items.forEach((p, idx) => {
    const num = idx + 1;
    parts.push(`${num}️⃣ ${p.finalTitle}`);
    parts.push(`🛒 المبيعات: ${p.orders || 0}`);
    parts.push(`⭐ التقييم: ${p.rating5 || "غير متوفر"}`);
    parts.push(`💰 السعر: ${p.priceILS || "غير متوفر"}`);
    parts.push(`${p.promotionLink}`);
    parts.push("");
  });
  return parts.join("\n").trim();
}

const WELCOME = `🤖 مرحبًا بكم في علي بوت AI"! 🎉

بوتنا الذكي يعرف كيف يعثر لكم على أفضل المنتجات على علي إكسبريس — اعتمادًا على التقييمات، المراجعات، وعمليات الشراء الحقيقية 🔍

فقط اكتبوا:
💬 ابحث عن... ثم اسم المنتج الذي تريدونه

وخلال ثوانٍ ستحصلون على أفضل الصفقات وأكثرها توفيرًا 💥

⚡️ نصيحة صغيرة: كلما كانت كتابتكم أدق — كانت النتائج أقرب لما تريدون 🎯`;

// -----------------------------
// Webhook setup + routes
// -----------------------------
app.get("/", (_req, res) => res.status(200).send("OK"));

app.post(WEBHOOK_PATH, (req, res) => {
  bot.processUpdate(req.body);
  res.sendStatus(200);
});

async function setWebhook() {
  await bot.setWebHook(WEBHOOK_URL);
  console.log(`Webhook set ✅`);
  console.log(`Webhook URL: ${WEBHOOK_URL}`);
}

// -----------------------------
// Bot handlers
// -----------------------------
bot.onText(/\/start/, async (msg) => {
  await bot.sendMessage(msg.chat.id, WELCOME);
});

bot.on("message", async (msg) => {
  try {
    if (!msg.text) return;
    const chatId = msg.chat.id;
    const text = msg.text.trim();

    if (text === "/start") return;

    // Accept:
    // "ابحث عن ..."
    // "ابحث لي عن ..."
    // "ابحث ..."
    // or plain text query
    let q = text;
    q = q.replace(/^ابحث\s+لي\s+عن\s+/i, "").trim();
    q = q.replace(/^ابحث\s+عن\s+/i, "").trim();
    q = q.replace(/^ابحث\s+/i, "").trim();

    if (q.length < 2) {
      await bot.sendMessage(chatId, "اكتب مثلًا:\nابحث عن ساعة ذكية\nابحث عن شاحن 65W");
      return;
    }

    const sent = await bot.sendMessage(chatId, "⏳ لحظة... بجمع أفضل النتائج");

    const items = await searchBestProducts(q);

    if (!items.length) {
      await bot.editMessageText("ما لقيت نتائج مناسبة. جرّب كلمة ثانية 🙂", {
        chat_id: chatId,
        message_id: sent.message_id,
      });
      return;
    }

    // collage (if we have images)
    const imgs = items.map((x) => ({ url: x.img }));
    const collagePath = `/tmp/collage_${Date.now()}.jpg`;
    try {
      await makeCollage4(imgs, collagePath);
      await bot.sendPhoto(chatId, collagePath, { caption: "" });
    } catch {
      // ignore collage failure and continue
    }

    const message = buildMessage(q, items);

    await bot.editMessageText(message, {
      chat_id: chatId,
      message_id: sent.message_id,
      disable_web_page_preview: true,
    });
  } catch (e) {
    console.error("Bot error:", e?.message || e);
    try {
      await bot.sendMessage(msg.chat.id, "صار خطأ بسيط. جرّب مرة ثانية 🙂");
    } catch {}
  }
});

// -----------------------------
// Start server
// -----------------------------
app.listen(PORT, async () => {
  console.log(`Server listening on ${PORT}`);
  await setWebhook();
  console.log("Deals48 bot running (webhook mode)...");
});
