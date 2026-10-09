import http from "node:http";
import TelegramBot from "node-telegram-bot-api";
import { cleanQuery, searchProducts } from "./search.js";

// ================== ENV ==================
// نقبل الأسماء المذكورة في README (.env.example) وأيضًا الأسماء القديمة، حتى لا تتعطل إعدادات Render الحالية.
const env = (...names) => names.map(n => process.env[n]).find(Boolean);

const BOT_TOKEN = env("TELEGRAM_BOT_TOKEN", "BOT_TOKEN");
const APP_KEY = env("AE_APP_KEY", "ALI_APP_KEY");
const APP_SECRET = env("AE_APP_SECRET", "ALI_APP_SECRET");

if (!BOT_TOKEN) throw new Error("Missing TELEGRAM_BOT_TOKEN (or BOT_TOKEN)");
if (!APP_KEY) throw new Error("Missing AE_APP_KEY (or ALI_APP_KEY)");
if (!APP_SECRET) throw new Error("Missing AE_APP_SECRET (or ALI_APP_SECRET)");

const CFG = {
  appKey: APP_KEY,
  appSecret: APP_SECRET,
  trackingId: env("TRACKING_ID") || "deals48bot",
  // البوابة الرسمية لـ aliexpress.affiliate.*؛ العنوان api.aliexpress.com هو موقع المتجر ويرجع صفحة "Maintaining"
  gateway: env("AE_GATEWAY") || "https://api-sg.aliexpress.com/sync",
  shipTo: env("SHIP_TO_COUNTRY"), // مثال: IL
  currency: env("TARGET_CURRENCY"), // مثال: ILS
  language: env("TARGET_LANGUAGE") || "EN",
  limit: Number(env("RESULTS_LIMIT")) || 4,
  fetchSize: 50, // نجلب عددًا أكبر ثم نفلتر ونرتّب محليًا بالصلة
};

const DEBUG = ["1", "true"].includes(String(env("DEBUG") || "").toLowerCase());
const whichName = (...names) => names.find(n => process.env[n]) || "-";
console.log(
  `config: key=${whichName("AE_APP_KEY", "ALI_APP_KEY")} secret=${whichName("AE_APP_SECRET", "ALI_APP_SECRET")} ` +
    `gateway=${CFG.gateway} shipTo=${CFG.shipTo || "-"} currency=${CFG.currency || "-"} lang=${CFG.language} debug=${DEBUG}`
);

// ================== BOT ==================
const bot = new TelegramBot(BOT_TOKEN, { polling: true });
bot.on("polling_error", err => console.error("polling_error:", err.message));
console.log("🤖 Telegram bot started");

// Render (Web Service) يتطلب منفذًا مفتوحًا، وهذا يسمح أيضًا بـ ping للإبقاء على الخدمة نشطة
http
  .createServer((_req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "Bot is running!" }));
  })
  .listen(Number(process.env.PORT) || 8000);

// ================== HELPERS ==================
function isMeaningfulQuery(q) {
  if (!q) return false;
  if (q.length < 3) return false;
  if (!/[a-zA-Z؀-ۿ֐-׿]/.test(q)) return false;
  if (q.length > 25 && !q.includes(" ")) return false;
  return true;
}

function buildCaption(p) {
  let title = p.title.trim();
  if (title.length > 120) title = title.slice(0, 117).trimEnd() + "...";

  let price = p.price ? `💰 ${p.price} ${p.currency}`.trim() : "💰 —";
  if (p.originalPrice && p.originalPrice !== p.price) price += `  (قبل: ${p.originalPrice})`;
  if (p.discount) price += `  ${p.discount}`;

  const lines = [`🛒 ${title}`, price];
  const extras = [];
  if (p.rating) extras.push(`⭐ ${p.rating}`);
  if (p.sales) extras.push(`📦 ${p.sales} مبيعات`);
  if (extras.length) lines.push(extras.join("  ·  "));
  if (p.url) lines.push(`🔗 ${p.url}`);
  return lines.join("\n").slice(0, 1000); // حد تيليجرام للكابتشن 1024
}

// ================== TELEGRAM HANDLER ==================
bot.on("message", async msg => {
  const chatId = msg.chat.id;
  const text = msg.text?.trim();
  if (!text) return;

  if (text.startsWith("/start")) {
    await bot.sendMessage(chatId, "أهلاً! 👋 أرسل اسم المنتج الذي تريده وسأبحث لك عن أفضل العروض.");
    return;
  }
  if (text.startsWith("/")) return;

  const query = cleanQuery(text);
  if (!isMeaningfulQuery(query)) {
    await bot.sendMessage(
      chatId,
      "❌ الطلب غير واضح\n\n✍️ مثال:\n• سماعة بلوتوث\n• شاحن USB-C\n• ساعة ذكية"
    );
    return;
  }

  await bot.sendMessage(chatId, "🔍 أبحث عن أفضل العروض…");

  try {
    const { products, keyword, error } = await searchProducts(query, CFG);

    if (!products.length) {
      if (error) {
        // فشل الاتصال/الصلاحيات ليس "لا توجد نتائج"، ونوضّح الفرق للمستخدم
        let text = "⚠️ تعذّر الاتصال بخدمة علي إكسبرس حاليًا. حاول لاحقًا.";
        if (DEBUG) text += `\n\n🛠 ${error}`.slice(0, 600);
        await bot.sendMessage(chatId, text);
      } else {
        let text = "😕 لم أجد منتجات مطابقة.\nجرّب اسمًا أوضح.";
        if (DEBUG) text += `\n\n🛠 بُحث بـ: ${keyword}`;
        await bot.sendMessage(chatId, text);
      }
      return;
    }

    if (keyword.toLowerCase() !== query.toLowerCase()) {
      await bot.sendMessage(chatId, `🌐 تم البحث بـ: ${keyword}`);
    }

    for (const p of products) {
      const caption = buildCaption(p);
      try {
        if (!p.image) throw new Error("no image");
        await bot.sendPhoto(chatId, p.image, { caption });
      } catch {
        // صورة معطوبة أو غير متاحة: نرسل النص وحده بدل أن نخسر المنتج
        await bot.sendMessage(chatId, caption, { disable_web_page_preview: true });
      }
    }
  } catch (err) {
    console.error(err);
    await bot.sendMessage(chatId, "❌ حدث خطأ أثناء البحث.");
  }
});
