import TelegramBot from "node-telegram-bot-api";

// ================== ENV ==================
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const RAPID_API_KEY = process.env.ALI_APP_SECRET; // لو كنت تستخدم RapidAPI غيّر هذا لاحقًا
const RAPID_API_HOST = "aliexpress-datahub.p.rapidapi.com";

if (!BOT_TOKEN) throw new Error("Missing TELEGRAM_BOT_TOKEN");
if (!RAPID_API_KEY) throw new Error("Missing ALI_APP_SECRET");

// ================== BOT ==================
const bot = new TelegramBot(BOT_TOKEN, { polling: true });
console.log("🤖 Telegram bot started");

// ================== HELPERS ==================
function isMeaningfulQuery(q) {
  if (!q) return false;
  if (q.length < 3) return false;
  if (!/[a-zA-Z\u0600-\u06FF]/.test(q)) return false;
  if (q.length > 15 && !q.includes(" ")) return false;
  return true;
}

function normalizeProduct(p) {
  return {
    title: p.product_title || "",
    price: p.app_sale_price || p.sale_price || "",
    image: p.product_main_image_url,
    link: p.product_detail_url,
  };
}

function relevanceScore(query, title) {
  const qWords = query
    .toLowerCase()
    .split(/\s+/)
    .filter(w => w.length > 2);
  const t = title.toLowerCase();
  return qWords.filter(w => t.includes(w)).length;
}

// ================== ALIEXPRESS SEARCH ==================
async function searchAliExpress(keyword) {
  const url = `https://${RAPID_API_HOST}/item_search?q=${encodeURIComponent(
    keyword
  )}&page=1&pageSize=25&sort=SALE_PRICE_ASC`;

  const res = await fetch(url, {
    headers: {
      "X-RapidAPI-Key": RAPID_API_KEY,
      "X-RapidAPI-Host": RAPID_API_HOST,
    },
  });

  if (!res.ok) return [];

  const json = await res.json();
  return json?.data?.products || [];
}

// ================== MAIN SEARCH ==================
async function searchBestProducts(query) {
  if (!isMeaningfulQuery(query)) return [];

  const raw = await searchAliExpress(query);
  if (!raw.length) return [];

  return raw
    .map(normalizeProduct)
    .map(p => ({ ...p, score: relevanceScore(query, p.title) }))
    .filter(p => p.score >= 1)
    .sort((a, b) => b.score - a.score)
    .slice(0, 5);
}

// ================== TELEGRAM HANDLER ==================
bot.on("message", async msg => {
  const chatId = msg.chat.id;
  const text = msg.text?.trim();

  if (!text) return;

  if (!isMeaningfulQuery(text)) {
    await bot.sendMessage(
      chatId,
      "❌ الطلب غير واضح\n\n✍️ مثال:\n• سماعة بلوتوث\n• شاحن USB-C\n• ساعة ذكية"
    );
    return;
  }

  await bot.sendMessage(chatId, "🔍 أبحث عن أفضل العروض…");

  try {
    const products = await searchBestProducts(text);

    if (!products.length) {
      await bot.sendMessage(
        chatId,
        "😕 لم أجد منتجات مطابقة تمامًا.\nجرّب اسمًا أوضح."
      );
      return;
    }

    for (const p of products) {
      await bot.sendPhoto(chatId, p.image, {
        caption:
          `🛒 ${p.title}\n` +
          `💰 السعر: ${p.price}\n` +
          `🔗 ${p.link}`,
      });
    }
  } catch (err) {
    console.error(err);
    await bot.sendMessage(chatId, "❌ حدث خطأ أثناء البحث.");
  }
});
