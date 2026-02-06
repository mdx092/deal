/**
 * Deals48 AI Bot — STRICT MODE
 * AliExpress Affiliate + Arabic
 * Webhook (Render / Express)
 */

import express from "express";
import crypto from "crypto";
import TelegramBot from "node-telegram-bot-api";
import axios from "axios";
import sharp from "sharp";
import OpenAI from "openai";

// ===================== ENV =====================
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
if (!BASE_URL) throw new Error("Missing BASE_URL");

const PORT = Number(process.env.PORT || 10000);
const WEBHOOK_PATH = `/bot${TELEGRAM_BOT_TOKEN}`;
const WEBHOOK_URL = `${BASE_URL}${WEBHOOK_PATH}`;

const bot = new TelegramBot(TELEGRAM_BOT_TOKEN, { webHook: true });
const app = express();
app.use(express.json({ limit: "5mb" }));

const openai = OPENAI_API_KEY ? new OpenAI({ apiKey: OPENAI_API_KEY }) : null;
const AI_MODEL = OPENAI_MODEL || "gpt-4.1-mini";

// ===================== HELPERS =====================
function toNumber(x) {
  if (x == null) return null;
  const n = Number(String(x).replace(/[^\d.]/g, ""));
  return Number.isFinite(n) ? n : null;
}

function uniqBy(arr, keyFn) {
  const s = new Set();
  return arr.filter((x) => {
    const k = keyFn(x);
    if (!k || s.has(k)) return false;
    s.add(k);
    return true;
  });
}

// ===================== STRICT VALIDATION =====================
function isMeaningfulQuery(q) {
  if (!q || q.length < 3) return false;
  if (!/[a-zA-Z\u0600-\u06FF]/.test(q)) return false;
  if (q.length > 14 && !q.includes(" ")) return false;
  return true;
}

function keywordMatchScore(query, title) {
  if (!title) return 0;
  const qWords = query.toLowerCase().split(/\s+/).filter(w => w.length > 2);
  const t = title.toLowerCase();
  return qWords.filter(w => t.includes(w)).length;
}

// ===================== TOP API =====================
function topTimestamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth()+1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function topSign(params, secret) {
  const keys = Object.keys(params).sort();
  let base = secret;
  for (const k of keys) base += `${k}${params[k]}`;
  base += secret;
  return crypto.createHash("md5").update(base).digest("hex").toUpperCase();
}

async function topCall(method, bizParams) {
  const params = {
    app_key: ALI_APP_KEY,
    method,
    format: "json",
    v: "2.0",
    sign_method: "md5",
    timestamp: topTimestamp(),
    ...bizParams,
  };
  params.sign = topSign(params, ALI_APP_SECRET);

  const body = new URLSearchParams(params);
  const r = await axios.post("https://api.taobao.com/router/rest", body.toString(), {
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    timeout: 20000,
  });
  return r.data;
}

async function affiliateProductQuery(keyword) {
  const data = await topCall("aliexpress.affiliate.product.query", {
    keywords: keyword,
    tracking_id: ALI_TRACKING_ID,
    target_language: "AR",
    target_currency: "ILS",
    ship_to_country: "IL",
    page_no: "1",
    page_size: "50",
  });

  const list =
    data?.aliexpress_affiliate_product_query_response?.resp_result?.result?.products?.product ||
    [];
  return Array.isArray(list) ? list : [];
}

// ===================== NORMALIZE =====================
function normalizeProduct(p) {
  return {
    id: String(p.product_id || ""),
    title: p.product_title || "",
    img: p.product_main_image_url || "",
    link: p.promotion_link || "",
    orders: toNumber(p.last_volume) || 0,
    rating: toNumber(p.evaluate_rate),
    price: toNumber(p.target_app_sale_price),
  };
}

// ===================== GPT (STRICT) =====================
async function aiFilter(userQuery, products) {
  if (!openai) return null;

  const payload = products.slice(0, 20).map(p => ({
    id: p.id,
    title: p.title,
  }));

  const instruction = `
أنت نظام تصفية صارم.
اعرض فقط المنتجات المرتبطة بوضوح بطلب المستخدم.
إذا لا يوجد تطابق واضح → أرجع {"items":[]} فقط.
لا تخمّن.

JSON فقط:
{"items":[{"id":"...","relevance":90}]}
`;

  const r = await openai.responses.create({
    model: AI_MODEL,
    input: [
      { role: "system", content: instruction },
      { role: "user", content: `طلب المستخدم: ${userQuery}\n${JSON.stringify(payload)}` },
    ],
    max_output_tokens: 400,
  });

  try {
    const j = JSON.parse(r.output_text);
    return j.items || [];
  } catch {
    return null;
  }
}

// ===================== MAIN SEARCH =====================
async function searchBestProducts(q) {
  if (!isMeaningfulQuery(q)) return [];

  const raw = await affiliateProductQuery(q);
  let products = raw.map(normalizeProduct)
    .filter(p => p.id && p.img && p.link)
    .filter(p => keywordMatchScore(q, p.title) >= 1);

  products = uniqBy(products, p => p.id);

  const ai = await aiFilter(q, products);
  if (ai) {
    const map = new Map(ai.map(x => [x.id, x.relevance]));
    products = products.filter(p => (map.get(p.id) || 0) >= 70);
  }

  products.sort((a,b)=>b.orders-a.orders);
  return products.slice(0,4);
}

// ===================== TELEGRAM =====================
const WELCOME = `🤖 أهلاً بك
اكتب: ابحث عن + اسم منتج واضح`;

app.get("/", (_req,res)=>res.send("OK"));
app.post(WEBHOOK_PATH, (req,res)=>{
  bot.processUpdate(req.body);
  res.sendStatus(200);
});

bot.onText(/\/start/, (msg)=>bot.sendMessage(msg.chat.id, WELCOME));

bot.on("message", async (msg)=>{
  if (!msg.text) return;
  const chatId = msg.chat.id;
  let q = msg.text.replace(/^ابحث\s+عن\s+/i,"").trim();

  if (!isMeaningfulQuery(q)) {
    await bot.sendMessage(chatId,"❌ اكتب اسم منتج واضح مثل: سماعة بلوتوث");
    return;
  }

  const wait = await bot.sendMessage(chatId,"🔍 أبحث عن نتائج دقيقة...");
  const items = await searchBestProducts(q);

  if (!items.length) {
    await bot.editMessageText("❌ لا توجد نتائج مرتبطة بهذا الطلب.",{
      chat_id:chatId,message_id:wait.message_id
    });
    return;
  }

  let text = `🔎 ${q}\n\n`;
  items.forEach((p,i)=>{
    text += `${i+1}️⃣ ${p.title}\n💰 ₪${p.price}\n🛒 ${p.orders}\n${p.link}\n\n`;
  });

  await bot.editMessageText(text,{
    chat_id:chatId,
    message_id:wait.message_id,
    disable_web_page_preview:true
  });
});

// ===================== START =====================
app.listen(PORT, async ()=>{
  await bot.deleteWebHook({ drop_pending_updates:true });
  await bot.setWebHook(WEBHOOK_URL);
  console.log("Bot running STRICT MODE");
});
